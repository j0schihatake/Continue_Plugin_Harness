/**
 * dsh-auto-press — браузерная половина.
 *
 * 1. Нажимает «Allow once» в диалоге подтверждения DSH, который появляется
 *    после того, как auto-approve отправил решение человеку.
 * 2. Нажимает «Play/Resume» у остановленной цели (если кнопку удаётся опознать).
 *
 * Чистый JS без import: DSH грузит клиентские модули через __ModuleLoader__.
 * Ctrl+Shift+A — включить/выключить. Состояние в localStorage.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-press',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const APPROVE_RE = /(allow once|allow-once|разрешить один раз|разрешить однократно)/i
    const GOAL_RESUME_SELECTOR = 'button[aria-label="Resume goal"]'
    const GOAL_PLAY_RE = /^(resume|resume goal|play|continue|продолжить|возобновить)/i
    const GOAL_CONTEXT_RE = /goal|цель|цели/i
    const CLICK_GOAL = true
    const DRY_RUN = false
    const LOG_KEY = 'dsh-auto-press-log'
    const ENABLED_KEY = 'dsh-auto-press-enabled'

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

      // Основной путь: точная кнопка панели цели (Inactive Goal → Resume goal).
      for (const el of document.querySelectorAll(GOAL_RESUME_SELECTOR)) {
        if (!visible(el)) continue
        if (clickButton(el, 'goal-play')) pressed = true
      }
      if (pressed) return true

      // Запасной путь: эвристика по подписи/контексту.
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

      log('загружен, состояние:', enabled ? 'включён' : 'выключен', '| Ctrl+Shift+A — переключить')
    }

    exports.name = 'dsh-auto-press'
    exports.inject = []
    exports.apply = apply
    exports.__test = { APPROVE_RE, GOAL_PLAY_RE, GOAL_RESUME_SELECTOR, visible, buttonText }
    return module.exports
  },
})
