/**
 * dsh-auto-press — браузерная половина.
 *
 * 1. Нажимает «Allow once» в диалоге подтверждения DSH.
 * 2. Нажимает «Play/Resume» у остановленной цели.
 * 3. Кнопки над полем ввода:
 *    «Цель»  — человек вручную задаёт goal (модель не может через инструменты).
 *    «Файлы» — список защищённых файлов (AGENTS.md, навыки, скрипты запуска),
 *              которые агенту запрещено менять, пока пользователь не снимет галку.
 *
 * Чистый JS без import: DSH грузит клиентские модули через __ModuleLoader__.
 * Ctrl+Shift+A — включить/выключить автопресс.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-press',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const APPROVE_RE = /(allow once|allow-once|разрешить один раз|разрешить однократно)/i
    const GOAL_RESUME_SELECTOR = 'button[aria-label="Resume goal"]'
    const GOAL_PLAY_RE = /^(resume|resume goal|play|continue|продолжить|возобновить)/i
    const GOAL_CONTEXT_RE = /goal|цель|цели/i
    const CLICK_GOAL = true
    const DRY_RUN = false
    const LOG_KEY = 'dsh-auto-press-log'
    const ENABLED_KEY = 'dsh-auto-press-enabled'
    const RPC_APP = 'dsh-auto-press'

    const CSS = `
.dap-bar{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;flex:none}
.dap-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
.dap-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dap-btn-on{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-label)}
.dap-dialog{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}
.dap-card{box-sizing:border-box;width:min(680px,92vw);max-height:82vh;display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary)}
.dap-title{font-size:14px;font-weight:600}
.dap-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dap-textarea{box-sizing:border-box;width:100%;min-height:96px;resize:vertical;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:13px/1.45 var(--ds-font-family-text)}
.dap-list{overflow:auto;max-height:46vh;display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:6px}
.dap-item{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:8px;font:12px/1.4 var(--ds-font-family-code);word-break:break-all}
.dap-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dap-actions{display:flex;justify-content:flex-end;gap:8px}
.dap-primary{background:var(--dsw-alias-state-success-primary);color:#fff;border-color:transparent}
.dap-msg{font-size:12px;color:var(--dsw-alias-label-secondary);min-height:16px}
.dap-msg-err{color:var(--dsw-alias-state-error-primary)}
`

    const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'
    let lastClick = 0
    let timer = null
    let enabled = true

    const log = (...a) => console.info('[auto-press]', new Date().toLocaleTimeString(), ...a)

    function remember(kind, text) {
      try {
        const arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]')
        arr.push({ t: Date.now(), kind, text })
        localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(-100)))
      } catch (_) {}
    }

    function visible(el) {
      if (!el || el.disabled) return false
      if (el.getAttribute('aria-disabled') === 'true') return false
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return false
      const st = getComputedStyle(el)
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
    }

    function buttonText(el) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    }

    function clickButton(el, kind) {
      if (Date.now() - lastClick < 800) return false
      lastClick = Date.now()
      const text = buttonText(el).slice(0, 60)
      if (DRY_RUN) {
        log('DRY_RUN:', kind, '→', text)
        remember(kind + '-dry', text)
        return true
      }
      el.click()
      log('нажал', kind, '→', text)
      remember(kind, text)
      return true
    }

    function pressAllowOnce() {
      let pressed = false
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        if (!visible(el)) continue
        const text = buttonText(el)
        if (!APPROVE_RE.test(text)) continue
        if (/deny|reject|отклон|запрет/i.test(text)) continue
        if (clickButton(el, 'allow-once')) pressed = true
      }
      return pressed
    }

    function pressGoalPlay() {
      if (!CLICK_GOAL) return false
      let pressed = false
      for (const el of document.querySelectorAll(GOAL_RESUME_SELECTOR)) {
        if (!visible(el)) continue
        if (clickButton(el, 'goal-play')) pressed = true
      }
      if (pressed) return true
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        if (!visible(el)) continue
        const label = [
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          buttonText(el),
        ].filter(Boolean).join(' ').trim()
        if (!GOAL_PLAY_RE.test(label)) continue
        const scope = el.closest('[data-goal], [class*="goal" i], [id*="goal" i]') ||
          (el.parentElement && GOAL_CONTEXT_RE.test(el.parentElement.textContent || '') ? el.parentElement : null)
        if (!scope) continue
        if (clickButton(el, 'goal-play')) pressed = true
      }
      return pressed
    }

    function tick() {
      timer = null
      if (!enabled) return
      try {
        pressAllowOnce()
        pressGoalPlay()
      } catch (e) {
        console.error('[auto-press]', e)
      }
    }

    function schedule() {
      if (timer) return
      timer = setTimeout(tick, 120)
    }

    function setEnabled(v) {
      enabled = v
      try { localStorage.setItem(ENABLED_KEY, v ? '1' : '0') } catch (_) {}
      log(v ? 'включён' : 'выключен')
    }

    function resolveFrame(sp) {
      if (!sp) return { sessionId: null }
      if (sp.sessionId) return { sessionId: sp.sessionId }
      if (sp.session && sp.session.id) return { sessionId: sp.session.id }
      return { sessionId: null }
    }

    function makeRpc(connection) {
      return function rpc(endpoint, payload) {
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          return Promise.reject(new Error('RPC недоступен'))
        }
        return connection.rpc.call('/api', RPC_APP, { endpoint, payload: payload || {} }).then((r) => {
          if (!r || r.ok === false) {
            const err = r && r.error
            throw new Error((err && (err.message || err.code)) || 'RPC failed')
          }
          return r.value
        }).catch((e) => {
          let msg = String((e && e.message) || e)
          if (/401|404|transport failure/i.test(msg)) {
            msg += ' — похоже, серверная часть плагина ещё не загружена: перезапустите DSH (systemctl --user restart deepseek-harness) и обновите страницу'
          }
          throw new Error(msg)
        })
      }
    }

    function GuardBar(props) {
      const rpc = props.rpc
      const frame = resolveFrame(props.slotsProps || {})
      const sessionId = frame.sessionId
      const [open, setOpen] = React.useState(null)
      const [goal, setGoal] = React.useState('')
      const [goalLock, setGoalLock] = React.useState(true)
      const [lockPerms, setLockPerms] = React.useState(true)
      const [paths, setPaths] = React.useState([])
      const [items, setItems] = React.useState([])
      const [addPath, setAddPath] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')

      function load() {
        setBusy(true); setErr('')
        rpc('snapshot', { sessionId }).then((v) => {
          const protectedSet = v.protectedPaths || []
          const all = Array.from(new Set([...(v.candidates || []), ...protectedSet]))
          setPaths(protectedSet)
          setItems(all)
          setGoalLock(v.goalLock !== false)
          setLockPerms(v.lockPerms !== false)
        }).catch((e) => setErr(String(e.message || e))).finally(() => setBusy(false))
      }

      function openDialog(which) {
        setOpen(which); setMsg(''); setErr('')
        if (which === 'files') load()
      }

      function submitGoal() {
        if (!goal.trim()) return
        setBusy(true); setErr('')
        rpc('setGoal', { sessionId, objective: goal }).then((v) => {
          setMsg('Цель установлена: ' + (v.objective || '').slice(0, 120))
          setGoal('')
        }).catch((e) => setErr(String(e.message || e))).finally(() => setBusy(false))
      }

      function togglePath(p, on) {
        setPaths((prev) => on ? Array.from(new Set([...prev, p])) : prev.filter((x) => x !== p))
      }

      function saveFiles() {
        setBusy(true); setErr('')
        rpc('setProtected', { paths }).then((v) => {
          setPaths(v.protectedPaths || [])
          setMsg('Сохранено: защищено ' + (v.protectedPaths || []).length + ' файл(ов)')
        }).catch((e) => setErr(String(e.message || e))).finally(() => setBusy(false))
      }

      function toggleLock() {
        const next = !goalLock
        rpc('setGoalLock', { enabled: next }).then((v) => {
          setGoalLock(v.goalLock !== false)
          setLockPerms(v.lockPerms !== false)
          setMsg(v.goalLock ? 'Смена цели из текста запрещена' : 'Смена цели из текста разрешена')
        }).catch((e) => setErr(String(e.message || e)))
      }

      function togglePerms() {
        const next = !lockPerms
        rpc('setLockPerms', { enabled: next }).then((v) => {
          setLockPerms(v.lockPerms !== false)
          setMsg(v.lockPerms ? 'Менять права и владельца файлов агенту запрещено' : 'Агенту разрешено менять права и владельца')
        }).catch((e) => setErr(String(e.message || e)))
      }

      function addToList() {
        const p = addPath.trim()
        if (!p) return
        if (!items.includes(p)) setItems((prev) => [...prev, p])
        if (!paths.includes(p)) setPaths((prev) => [...prev, p])
        setAddPath('')
      }

      const e = React.createElement
      const buttons = e('div', { className: 'dap-bar' },
        e('button', { className: 'dap-btn' + (goalLock ? ' dap-btn-on' : ''), onClick: () => openDialog('goal'), title: 'Задать цель вручную (модель не может)' }, '🎯 Цель'),
        e('button', { className: 'dap-btn' + (paths.length ? ' dap-btn-on' : ''), onClick: () => openDialog('files'), title: 'Защитить файлы от изменений агентом' }, '🗂 Файлы' + (paths.length ? ' · ' + paths.length : '')),
      )

      let dialog = null
      if (open === 'goal') {
        dialog = e('div', { className: 'dap-dialog', onClick: (ev) => { if (ev.target === ev.currentTarget) setOpen(null) } },
          e('div', { className: 'dap-card' },
            e('div', { className: 'dap-title' }, 'Цель для агента'),
            e('div', { className: 'dap-sub' }, 'Только это поле задаёт goal. Модель не может менять цель ни из текста, ни инструментами.'),
            e('textarea', { className: 'dap-textarea', value: goal, placeholder: 'Что нужно сделать…', onChange: (ev) => setGoal(ev.target.value) }),
            e('div', { className: 'dap-msg' + (err ? ' dap-msg-err' : '') }, err || msg),
            e('div', { className: 'dap-actions' },
              e('button', { className: 'dap-btn', onClick: () => setOpen(null) }, 'Отмена'),
              e('button', { className: 'dap-btn dap-primary', disabled: busy || !goal.trim(), onClick: submitGoal }, busy ? '…' : 'Установить цель'),
            ),
          ),
        )
      } else if (open === 'files') {
        dialog = e('div', { className: 'dap-dialog', onClick: (ev) => { if (ev.target === ev.currentTarget) setOpen(null) } },
          e('div', { className: 'dap-card' },
            e('div', { className: 'dap-title' }, 'Защита файлов от агента'),
            e('div', { className: 'dap-sub' }, 'Отмеченные файлы агент не может менять (write/edit/bash). Чтобы правка стала возможна, снимите галку — агент попросит об этом.'),
            e('label', { className: 'dap-item' },
              e('input', { type: 'checkbox', checked: goalLock, onChange: toggleLock }),
              e('span', null, 'Запретить агенту менять цель из текста'),
            ),
            e('label', { className: 'dap-item' },
              e('input', { type: 'checkbox', checked: lockPerms, onChange: togglePerms }),
              e('span', null, 'Запретить агенту менять права (chmod) и владельца (chown) файлов'),
            ),
            e('div', { className: 'dap-list' },
              items.map((p) => e('label', { className: 'dap-item', key: p },
                e('input', { type: 'checkbox', checked: paths.includes(p), onChange: (ev) => togglePath(p, ev.target.checked) }),
                e('span', null, p),
              )),
            ),
            e('div', { className: 'dap-actions' },
              e('input', { className: 'dap-textarea', style: { minHeight: 0, height: 30, flex: '1 1 auto' }, value: addPath, placeholder: 'Добавить путь…', onChange: (ev) => setAddPath(ev.target.value) }),
              e('button', { className: 'dap-btn', onClick: addToList }, 'Добавить'),
            ),
            e('div', { className: 'dap-msg' + (err ? ' dap-msg-err' : '') }, err || msg),
            e('div', { className: 'dap-actions' },
              e('button', { className: 'dap-btn', onClick: () => setOpen(null) }, 'Закрыть'),
              e('button', { className: 'dap-btn dap-primary', disabled: busy, onClick: saveFiles }, busy ? '…' : 'Сохранить'),
            ),
          ),
        )
      }

      return e(React.Fragment, null, buttons, dialog)
    }

    function apply(ctx) {
      if (!isBrowser) return
      try {
        enabled = localStorage.getItem(ENABLED_KEY) !== '0'
      } catch (_) {}

      const mo = new MutationObserver(schedule)
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled'],
      })
      setInterval(schedule, 700)

      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && /^[aAаАфФ]$/.test(e.key)) {
          e.preventDefault()
          setEnabled(!enabled)
        }
      })

      try {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-auto-press')
        style.textContent = CSS
        document.head.appendChild(style)
      } catch (e) {
        console.error('[auto-press] CSS', e)
      }

      if (ctx && ctx.slots) {
        try {
          const rpc = makeRpc(ctx.connection)
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
            { name: 'conversation.input.dock', id: 'dsh-auto-press.guard', order: 10, label: () => 'Цель и файлы' },
            (props) => React.createElement(GuardBar, { slotsProps: props, rpc }),
          ))
        } catch (e) {
          console.error('[auto-press] не удалось зарегистрировать панель «Цель и файлы»', e)
        }
      }

      log('загружен, состояние:', enabled ? 'включён' : 'выключен', '| Ctrl+Shift+A — переключить')
    }

    exports.name = 'dsh-auto-press'
    exports.inject = ['connection', 'slots']
    exports.apply = apply
    exports.__test = { APPROVE_RE, GOAL_PLAY_RE, GOAL_RESUME_SELECTOR, visible, buttonText }
    return module.exports
  },
})
