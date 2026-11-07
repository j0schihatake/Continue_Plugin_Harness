# dsh-auto-press

DeepSeek Harness plugin: автоматически нажимает **Allow once** в диалоге подтверждения и пытается нажать **Play/Resume** у остановленной цели.

Работает в браузерной половине плагина (client.js), поэтому не зависит от хоста и не требует RPC.

## Что делает

- Наблюдает DOM (`MutationObserver` + страховочный `setInterval`).
- Кнопку с текстом `Allow once` (или `разрешить один раз`) нажимает автоматически — это диалог, который появляется после того, как `dsh-auto-approve` отправил решение судьи человеку.
- Ищет кнопку `Play/Resume/Continue` внутри контейнера цели (`[data-goal]`, `class*="goal"`, текст «Goal/Цель») и нажимает её.
- `Ctrl+Shift+A` — включить/выключить. Состояние и последние 100 нажатий — в `localStorage`.
- Не трогает «Deny/Reject», кликает только видимые и активные кнопки, не чаще одного клика в 800 мс.

## Установка

```bash
# локально из папки
dsh plugin --profile web add file:/home/j0schi/Program/Strata/dsh-auto-press

# или из git
dsh plugin --profile web add github:<user>/dsh-auto-press
```

После установки перезапустить `dsh web` (страница GUI перезагрузится).

Проверка:

```bash
dsh --profile web --dump-config | grep -i auto-press
```

Удаление:

```bash
dsh plugin --profile web remove dsh-auto-press
```

## Настройки

В `client.js`:

- `DRY_RUN = true` — ничего не нажимать, только писать в консоль «нажал бы».
- `CLICK_GOAL = false` — отключить автоплей цели.
- `APPROVE_RE` / `GOAL_PLAY_RE` — регулярки под ваши подписи кнопок.

## Известные ограничения

- Кнопка «Play» у цели ищется эвристикой: если у неё нет текста/`aria-label` или контейнер не содержит `goal`, автоплей не сработает — подставьте точный селектор.
- Клиентская половина грузится в браузере; если DSH обновится и поменяет разметку диалога, регулярку надо будет поправить.
- Автонажатие «Allow once» снимает ручное подтверждение рискованных операций — используйте осознанно.

## Структура

```
package.json        # dsh.bundle.patch + dsh.client (platform web)
cordis.patch.yml    # bundle-патч, вставляет плагин в профиль
src/index.mjs       # хост-половина (заглушка, логирует загрузку)
client.js           # браузерная половина: __ModuleLoader__.load({ id, factory })
```
