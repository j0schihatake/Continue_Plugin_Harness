/**
 * dsh-auto-press — host half.
 *
 * 1. Auto-press работа по-прежнему живёт в client.js (Allow once / Resume goal).
 * 2. Здесь — защита от модели:
 *    - goalLock: модель не может менять цель инструментами create_goal/update_goal;
 *      цель задаёт только человек кнопкой «Цель» (client.js → RPC setGoal).
 *    - protectedPaths: перечисленные файлы (AGENTS.md, навыки, скрипты запуска…)
 *      модель не может менять ни write/edit, ни bash-командой записи.
 *    - lockPerms: модель не может менять права (chmod/chattr) и владельца (chown).
 *      Модель получает отказ и должна попросить человека снять галку.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-auto-press'
export const inject = ['agents', 'goals']

const DIR = path.join(os.homedir(), '.dsh', 'auto-press')
const CONFIG_FILE = path.join(DIR, 'config.json')
const DEFAULTS = { goalLock: true, lockPerms: true, protectedPaths: [] }

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return {
      goalLock: raw.goalLock !== false,
      lockPerms: raw.lockPerms !== false,
      protectedPaths: Array.isArray(raw.protectedPaths)
        ? raw.protectedPaths.filter((p) => typeof p === 'string' && p.trim())
        : [],
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

const FILE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'multiedit', 'str_replace', 'create_file'])
const BASH_WRITE = /(^|[\s;&|])(>|>>|tee\b|sed\s+-i\b|cp\b|mv\b|rm\b|truncate\b|install\b|patch\b|touch\b)/
const BASH_PERMS = /(^|[\s;&|])(chmod|chown|chgrp|chattr|setfacl|setfattr)\b/

export function apply(ctx) {
  const log = ctx && ctx.logger && typeof ctx.logger.info === 'function'
    ? ctx.logger.info.bind(ctx.logger)
    : console.log
  const warn = ctx && ctx.logger && typeof ctx.logger.warn === 'function'
    ? ctx.logger.warn.bind(ctx.logger)
    : console.warn
  const cfg = loadConfig()

  const norm = (p) => path.resolve(String(p)).replace(/\/+$/, '')

  function isProtected(target, list) {
    if (!target) return null
    const abs = norm(target)
    for (const raw of list) {
      const pat = norm(raw)
      if (abs === pat || abs.startsWith(pat + '/')) return raw
    }
    return null
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = String((exec && exec.name) || '')
    const args = (exec && exec.arguments) || {}
    try {
      if (cfg.goalLock && (tool === 'create_goal' || tool === 'update_goal')) {
        return {
          kind: 'deny',
          reason: 'Цель меняется только человеком через кнопку «Цель» над полем ввода. '
            + 'Из текста/контекста менять goal нельзя: попросите пользователя нажать кнопку.',
        }
      }
      if (FILE_TOOLS.has(tool)) {
        const target = args.file_path || args.path || args.target
        const hit = isProtected(target, cfg.protectedPaths)
        if (hit) {
          return {
            kind: 'deny',
            reason: `Файл «${target}» защищён от изменений агентом (кнопка «Файлы»). `
              + 'Попросите пользователя снять галку с этого файла, если правка действительно нужна.',
          }
        }
      }
      if (tool === 'bash' && typeof args.command === 'string') {
        const cmd = args.command
        if (cfg.lockPerms && BASH_PERMS.test(cmd)) {
          return {
            kind: 'deny',
            reason: 'Менять права (chmod/chattr) и владельца (chown) файлов агенту запрещено '
              + '(кнопка «Файлы»). Попросите пользователя снять галку «права и владелец».',
          }
        }
        if (BASH_WRITE.test(cmd)) {
          for (const p of cfg.protectedPaths) {
            if (cmd.includes(p)) {
              return {
                kind: 'deny',
                reason: `Команда изменяет защищённый файл «${p}» (кнопка «Файлы»). `
                  + 'Попросите пользователя снять галку, если правка нужна.',
              }
            }
          }
        }
      }
    } catch (error) {
      warn(`[dsh-auto-press] guard error: ${error}`)
    }
    return next()
  })

  function sessionCwd(sessionId) {
    try {
      const agents = services && services.agents
      const agent = sessionId && agents ? agents.get(sessionId) : undefined
      const header = agent && agent.session && agent.session.header
      if (header && typeof header.cwd === 'string') return header.cwd
    } catch {}
    return ''
  }

  function resolvePath(p, cwd) {
    const s = String(p || '').trim()
    if (!s) return ''
    if (path.isAbsolute(s)) return path.normalize(s)
    return cwd ? path.resolve(cwd, s) : s
  }

  function candidates(sessionId) {
    const out = new Set(cfg.protectedPaths)
    const cwd = sessionCwd(sessionId)
    const add = (p) => { try { out.add(p) } catch {} }
    if (cwd) {
      add(path.join(cwd, 'AGENTS.md'))
      add(path.join(cwd, 'CLAUDE.md'))
      add(path.join(cwd, 'AGENT.md'))
    }
    add(path.join(os.homedir(), '.dsh', 'AGENTS.md'))
    try {
      const skillsRoot = path.join(os.homedir(), '.agents', 'skills')
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) add(path.join(skillsRoot, entry.name, 'SKILL.md'))
      }
    } catch {}
    return Array.from(out)
  }

  let services = null

  async function setGoal(sessionId, objective) {
    const text = String(objective || '').trim()
    if (!text) throw new Error('пустая цель')
    const agents = services && services.agents
    const goals = services && services.goals
    if (!agents) throw new Error('сервис агентов недоступен')
    if (!goals) throw new Error('сервис целей недоступен')
    const agent = sessionId ? agents.get(sessionId) : undefined
    if (!agent) throw new Error('нет активного агента для этой сессии')
    const current = goals.get(agent)
    if (!current) return goals.create(agent, { objective: text })
    if (current.phase === 'complete') return goals.create(agent, { objective: text })
    return goals.edit(agent, { id: current.id, revision: current.revision }, { objective: text })
  }

  async function dispatch(endpoint, payload) {
    const p = payload && typeof payload === 'object' ? payload : {}
    if (endpoint === 'snapshot') {
      return {
        goalLock: cfg.goalLock,
        lockPerms: cfg.lockPerms,
        protectedPaths: cfg.protectedPaths,
        candidates: candidates(p.sessionId),
      }
    }
    if (endpoint === 'setGoalLock') {
      cfg.goalLock = !!p.enabled
      saveConfig(cfg)
      return { goalLock: cfg.goalLock }
    }
    if (endpoint === 'setLockPerms') {
      cfg.lockPerms = !!p.enabled
      saveConfig(cfg)
      return { lockPerms: cfg.lockPerms }
    }
    if (endpoint === 'setProtected') {
      const cwd = sessionCwd(p.sessionId)
      const list = Array.isArray(p.paths) ? p.paths : []
      cfg.protectedPaths = Array.from(new Set(
        list.map((s) => resolvePath(s, cwd)).filter(Boolean),
      ))
      saveConfig(cfg)
      return { protectedPaths: cfg.protectedPaths }
    }
    if (endpoint === 'setGoal') {
      const view = await setGoal(p.sessionId, p.objective)
      return { id: view.id, phase: view.phase, objective: view.objective }
    }
    throw new Error(`unknown endpoint ${endpoint}`)
  }

  ctx.inject(['connection', 'agents', 'goals'], (c) => {
    services = c
    const connection = c.connection
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
      warn('[dsh-auto-press] connection.fetch недоступен — кнопки в UI не заработают')
      return
    }
    async function serve(request) {
      let body = {}
      try { body = await request.json() } catch {}
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
      const packed = (body && body.payload) || {}
      const endpoint = String(packed.endpoint || '')
      const payload = packed.payload || {}
      try {
        const value = await dispatch(endpoint, payload)
        return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
      } catch (error) {
        return Response.json({
          type: 'server-response',
          rpcId,
          result: { ok: false, error: { code: 'err.internal', message: String((error && error.message) || error), details: {} } },
        })
      }
    }
    c.effect(
      () => connection.fetch.register({
        path: '/api/dsh-auto-press',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: serve,
      }),
      'dsh-auto-press: /api/dsh-auto-press',
    )
    log('[dsh-auto-press] RPC зарегистрирован: /api/dsh-auto-press')
  })

  log(`[dsh-auto-press] loaded: goalLock=${cfg.goalLock}, lockPerms=${cfg.lockPerms}, protected=${cfg.protectedPaths.length}`)
}
