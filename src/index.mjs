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
const DEFAULTS = { goalLock: true, lockPerms: true, strictOutside: true, lockPlugins: true, approveWithoutTab: false, protectedPaths: [], extraRoots: [] }

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return {
      goalLock: raw.goalLock !== false,
      lockPerms: raw.lockPerms !== false,
      strictOutside: raw.strictOutside !== false,
      lockPlugins: raw.lockPlugins !== false,
      approveWithoutTab: raw.approveWithoutTab === true,
      protectedPaths: Array.isArray(raw.protectedPaths)
        ? raw.protectedPaths.filter((p) => typeof p === 'string' && p.trim())
        : [],
      extraRoots: Array.isArray(raw.extraRoots)
        ? raw.extraRoots.filter((p) => typeof p === 'string' && p.trim())
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
// Сетевые настройки: запрещены вне разрешённых папок (доп. слой защиты системы).
const NET_CMD = /(^|[\s;&|])(nmcli|nmtui|ip\s+(addr|a|route|r|link|rule|neigh|netns)|iptables|ip6tables|nft|ufw|firewall-cmd|resolvectl|systemd-resolve|networkctl|wpa_supplicant|wpa_cli|dhclient|dhcpcd|ifconfig|route|hostnamectl|timedatectl|netplan)\b/
// Системные изменения: пакеты, юниты, монтирование, пользователи, загрузчик.
const SYS_CMD = /(^|[\s;&|])(apt|apt-get|dpkg|snap|mount|umount|modprobe|insmod|rmmod|reboot|shutdown|poweroff|halt|systemctl\s+(start|stop|restart|reload|disable|enable|mask|unmask|daemon-reload)|useradd|usermod|userdel|passwd|chpasswd|crontab|visudo|ldconfig|update-grub|mkfs|fdisk|parted)\b/
// Запись в системные каталоги — запрещена вне разрешённых папок.
const CRITICAL_PATH = /^\/(etc|usr|boot|lib|lib64|bin|sbin|var|opt|root|proc|sys|snap|run)(\/|$)/
// Маркер «админ разрешил полный доступ». Создать его может только root
// (файл должен принадлежать uid 0), поэтому обычный пользователь и агент
// не могут включить danger-full-access самостоятельно.
const ADMIN_MARKER = path.join(DIR, 'admin-unlocked')

export function apply(ctx) {
  const log = ctx && ctx.logger && typeof ctx.logger.info === 'function'
    ? ctx.logger.info.bind(ctx.logger)
    : console.log
  const warn = ctx && ctx.logger && typeof ctx.logger.warn === 'function'
    ? ctx.logger.warn.bind(ctx.logger)
    : console.warn
  const cfg = loadConfig()

  const PLUGIN_ROOTS = [
    path.join(os.homedir(), '.dsh', 'profiles'),
    path.join(os.homedir(), '.dsh', 'plugins'),
    path.join(os.homedir(), '.dsh', 'node_modules'),
    '/home/j0schi/Program/Strata/Continue_Plugin_Harness',
  ]
  const PLUGIN_PKG_CMD = /(^|[\s;&|])(pnpm|npm|yarn)\s+(add|remove|uninstall|install|i)\b/
  const pending = new Map()

  // Полный доступ разрешён только при наличии корневого маркера.
  const adminUnlocked = () => {
    try {
      const st = fs.statSync(ADMIN_MARKER)
      return st.isFile() && st.uid === 0
    } catch {
      return false
    }
  }

  const norm = (p) => path.resolve(String(p)).replace(/\/+$/, '')

  function underRoots(target, roots) {
    if (!target) return false
    const abs = norm(target)
    return roots.some((r) => {
      const root = norm(r)
      return abs === root || abs.startsWith(root + '/')
    })
  }

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
      if (exec && exec.callId) {
        pending.set(String(exec.callId), { tool, args, at: Date.now() })
        if (pending.size > 500) {
          const oldest = pending.keys().next().value
          pending.delete(oldest)
        }
      }
      if (args && args.sandbox_permissions === 'danger-full-access' && !adminUnlocked()) {
        return {
          kind: 'deny',
          reason: 'Полный доступ (danger-full-access) выключен: включить его может только админ '
            + 'командой «sudo touch /home/j0schi/.dsh/auto-press/admin-unlocked ». '
            + 'Работайте в обычном режиме или попросите админа.',
        }
      }
      if (cfg.goalLock && (tool === 'create_goal' || tool === 'update_goal')) {
        return {
          kind: 'deny',
          reason: 'Цель меняется только человеком через кнопку «Цель» над полем ввода. '
            + 'Из текста/контекста менять goal нельзя: попросите пользователя нажать кнопку.',
        }
      }
      if (FILE_TOOLS.has(tool)) {
        const target = args.file_path || args.path || args.target
        if (target && underRoots(target, [DIR])) {
          return {
            kind: 'deny',
            reason: 'Настройки плагина защищены: менять config.json агенту нельзя. '
              + 'Состояние кнопок задаёт только пользователь в интерфейсе.',
          }
        }
        if (target && cfg.strictOutside && !underRoots(target, cfg.extraRoots) && CRITICAL_PATH.test(String(target))) {
          return {
            kind: 'deny',
            reason: `Запись в системный каталог «${target}» запрещена: это не рабочая папка проекта. `
              + 'Добавьте каталог в «Настройки», только если правка действительно нужна.',
          }
        }
        const hit = isProtected(target, cfg.protectedPaths)
        if (target && cfg.lockPlugins && underRoots(target, PLUGIN_ROOTS)) {
          return {
            kind: 'deny',
            reason: `Плагины защищены (кнопка «Плагины»): менять «${target}» агенту нельзя. `
              + 'Попросите пользователя выключить защиту плагинов.',
          }
        }
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
        const inRoots = cfg.extraRoots.some((r) => cmd.includes(r))
        if (cmd.includes(DIR) && BASH_WRITE.test(cmd)) {
          return {
            kind: 'deny',
            reason: 'Настройки плагина защищены: менять его config.json командой агенту нельзя.',
          }
        }
        if (cfg.lockPlugins) {
          const touchesPlugins = PLUGIN_ROOTS.some((r) => cmd.includes(r))
            || /\.dsh\/profiles|\.dsh\/plugins/.test(cmd)
          if (touchesPlugins && (BASH_WRITE.test(cmd) || PLUGIN_PKG_CMD.test(cmd))) {
            return {
              kind: 'deny',
              reason: 'Плагины защищены (кнопка «Плагины»): менять, переписывать или добавлять плагины агенту нельзя. '
                + 'Попросите пользователя выключить защиту плагинов.',
            }
          }
        }
        if (cfg.strictOutside && !inRoots && NET_CMD.test(cmd)) {
          return {
            kind: 'deny',
            reason: 'Сетевые настройки менять запрещено (nmcli/ip/iptables/nft/resolvectl…). '
              + 'Это защита системы, а не часть задачи.',
          }
        }
        if (cfg.strictOutside && !inRoots && SYS_CMD.test(cmd)) {
          return {
            kind: 'deny',
            reason: 'Системные изменения (пакеты, юниты, монтирование, пользователи) запрещены. '
              + 'Это защита системы, а не часть задачи.',
          }
        }
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

  function safeForApproval(tool, args) {
    if (args && args.sandbox_permissions === 'danger-full-access' && !adminUnlocked()) return false
    if (cfg.goalLock && (tool === 'create_goal' || tool === 'update_goal')) return false
    if (FILE_TOOLS.has(tool)) {
      const target = args.file_path || args.path || args.target
      if (target && cfg.lockPlugins && underRoots(target, PLUGIN_ROOTS)) return false
      if (target && cfg.strictOutside && !underRoots(target, cfg.extraRoots) && CRITICAL_PATH.test(String(target))) return false
      if (isProtected(target, cfg.protectedPaths)) return false
    }
    if (tool === 'bash' && typeof args.command === 'string') {
      const cmd = args.command
      if (cfg.lockPerms && BASH_PERMS.test(cmd)) return false
      if (cfg.strictOutside && NET_CMD.test(cmd)) return false
      if (cfg.strictOutside && SYS_CMD.test(cmd)) return false
      if (cfg.lockPlugins) {
        const touches = PLUGIN_ROOTS.some((r) => cmd.includes(r)) || /\.dsh\/profiles|\.dsh\/plugins/.test(cmd)
        if (touches && (BASH_WRITE.test(cmd) || PLUGIN_PKG_CMD.test(cmd))) return false
      }
      if (BASH_WRITE.test(cmd)) {
        for (const p of cfg.protectedPaths) if (cmd.includes(p)) return false
      }
    }
    return true
  }

  // Одобрение без открытой вкладки проекта: выполняется раньше auto-approve и
  // одобряет только те вызовы, которые проходят все наши проверки.
  ctx.on('approval/request', async (req, next) => {
    try {
      if (!cfg.approveWithoutTab) return next()
      const id = String((req && req.callId) || '')
      const rec = id ? pending.get(id) : undefined
      if (!rec) return next()
      if (rec.args && rec.args.sandbox_permissions === 'danger-full-access' && !adminUnlocked()) {
        pending.delete(id)
        return 'rejected'
      }
      if (safeForApproval(rec.tool, rec.args)) {
        pending.delete(id)
        return 'allowed-once'
      }
    } catch (error) {
      warn(`[dsh-auto-press] approval check failed: ${error}`)
    }
    return next()
  }, { prepend: true })

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
        strictOutside: cfg.strictOutside,
        lockPlugins: cfg.lockPlugins,
        approveWithoutTab: cfg.approveWithoutTab,
        protectedPaths: cfg.protectedPaths,
        extraRoots: cfg.extraRoots,
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
    if (endpoint === 'setExtraRoots') {
      const cwd = sessionCwd(p.sessionId)
      const list = Array.isArray(p.paths) ? p.paths : []
      cfg.extraRoots = Array.from(new Set(list.map((s) => resolvePath(s, cwd)).filter(Boolean)))
      saveConfig(cfg)
      return { extraRoots: cfg.extraRoots }
    }
    if (endpoint === 'setStrictOutside') {
      cfg.strictOutside = !!p.enabled
      saveConfig(cfg)
      return { strictOutside: cfg.strictOutside }
    }
    if (endpoint === 'setLockPlugins') {
      cfg.lockPlugins = !!p.enabled
      saveConfig(cfg)
      return { lockPlugins: cfg.lockPlugins }
    }
    if (endpoint === 'setApproveWithoutTab') {
      cfg.approveWithoutTab = !!p.enabled
      saveConfig(cfg)
      return { approveWithoutTab: cfg.approveWithoutTab }
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
