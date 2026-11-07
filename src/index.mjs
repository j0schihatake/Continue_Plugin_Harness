/**
 * dsh-auto-press — host half.
 *
 * Вся работа сделана в браузерной половине (client.js): она нажимает
 * «Allow once» в диалоге подтверждения и «Play» у остановленной цели.
 * Хост-половина нужна только чтобы пакет был валидным bundle и грузился в профиль.
 */
export const name = 'dsh-auto-press'

export function apply(ctx) {
  const log = ctx && ctx.logger && typeof ctx.logger.info === 'function'
    ? ctx.logger.info.bind(ctx.logger)
    : console.log
  log('[dsh-auto-press] loaded (client half does the work)')
}
