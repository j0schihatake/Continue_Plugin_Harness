# dsh-auto-press

DeepSeek Harness plugin: автоматически нажимает **Allow once** в диалоге подтверждения и **Resume goal** у остановленной цели.

Работает в браузерной половине плагина (`client.js`), поэтому не зависит от хоста и не требует RPC.

## Экосистема: с чем этот плагин работает

`dsh-auto-press` — третье звено связки из трёх плагинов:

| Плагин | Роль | Где настраивается |
|---|---|---|
| [`@dnalec/dsh-auto-approve`](https://github.com/DNAlec/dsh-auto-approve) | Судья: решает, можно ли выполнить операцию без человека | Settings → **Auto-approve** |
| [`@machine-126/dsh-alert-sound`](https://github.com/Machine-126/dsh-alert-sound) | Звук: сообщает, что агент ждёт подтверждения | Settings → **Reminder sounds** |
| `dsh-auto-press` (этот) | Руки: жмёт **Allow once** и **Resume goal** | `client.js`, `Ctrl+Shift+A` |

Как это работает вместе:

1. Агент просит разрешение на операцию.
2. `dsh-auto-approve` прогоняет запрос через судью. Если решает «можно» — операция идёт дальше без диалога. Если «рискованно» — отдаёт человеку.
3. `dsh-alert-sound` играет звук «нужно подтверждение».
4. `dsh-auto-press` ждёт появления диалога в DOM — и сам нажимает **Allow once**. Так же сам нажимает **Resume goal**, когда цель уходит в `Inactive Goal`.

### Установка всей связки

```bash
dsh plugin --profile web add @dnalec/dsh-auto-approve
dsh plugin --profile web add @machine-126/dsh-alert-sound
dsh plugin --profile web add github:j0schihatake/Continue_Plugin_Harness
```

Затем перезапустить DSH:

```bash
systemctl --user restart deepseek-harness
# или перезапустить приложение DeepSeek Harness
```

После перезапуска:

- в **Settings → Auto-approve** проверить матрицу критериев (по умолчанию `medium = human` — именно этот случай и закрывает `dsh-auto-press`);
- в **Settings → Reminder sounds** включить звук «Needs approval» (по желанию — повтор и голос);
- в сессии выбрать пресет разрешений **Auto-approve**.

### dsh-auto-approve — коротко

- Ставится из npm (`@dnalec/dsh-auto-approve`) или с GitHub (`github:DNAlec/dsh-auto-approve`).
- При первом запуске сам добавляет пресет **Auto-approve** в профиль.
- Работает только когда в сессии выбран этот пресет.
- Ключевые настройки: модель-судья, таблица критериев (три уровня: low/medium/high), ключевые слова «отклонить / спросить человека / разрешить», лимит запроса к судье.
- Конфиг: `~/.dsh/auto-approve/allowlist.json`, события: `events.jsonl`, аудит: `audit.log`.

### dsh-alert-sound — коротко

- Ставится из npm (`@machine-126/dsh-alert-sound`) или с GitHub (`github:Machine-126/dsh-alert-sound`), есть и локальная установка абсолютным путём.
- Пять типов оповещений: нужно подтверждение, нужен ответ, вывод завершён, ошибка, «застряло» (экспериментально).
- Умеет синтезированные сигналы и голос (zh/en), повтор до реакции, часы «не беспокоить», системные уведомления, чтение финального ответа.
- Работает офлайн, всё в браузере; настройки — в **Settings → Reminder sounds**.

## Что делает dsh-auto-press

- Наблюдает DOM (`MutationObserver` + страховочный `setInterval`).
- **Allow once** — нажимает кнопку с таким текстом (или «разрешить один раз»); это диалог, который появляется после того, как судья отправил решение человеку.
- **Resume goal** — нажимает `button[aria-label="Resume goal"]` (кнопка ▶ на панели `Inactive Goal`); если точный селектор не найден, пробует эвристику по подписи и контексту.
- `Ctrl+Shift+A` — включить/выключить. Состояние и последние 100 нажатий — в `localStorage`.
- Не трогает «Deny/Reject», кликает только видимые и активные кнопки, не чаще одного клика в 800 мс.

## Установка самого dsh-auto-press

```bash
# из git
dsh plugin --profile web add github:j0schihatake/Continue_Plugin_Harness

# или локально из папки
dsh plugin --profile web add file:/home/j0schi/Program/Strata/dsh-auto-press
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
- `APPROVE_RE` / `GOAL_PLAY_RE` / `GOAL_RESUME_SELECTOR` — регулярки и селектор под вашу разметку.

## Известные ограничения

- Кнопка «Resume goal» ищется по `aria-label`; если DSH поменяет разметку — поправить `GOAL_RESUME_SELECTOR`.
- Клиентская половина грузится в браузере; после обновления DSH проверьте, что `[auto-press]` есть в консоли.
- Автонажатие «Allow once» и автоплей цели снимают ручной контроль — используйте осознанно.
- Автоплей возобновляет **любую** цель в `Inactive Goal`, включая приостановленную вручную.

## Структура

```
package.json        # dsh.bundle.patch + dsh.client (platform web)
cordis.patch.yml    # bundle-патч, вставляет плагин в профиль
src/index.mjs       # хост-половина (заглушка, логирует загрузку)
client.js           # браузерная половина: __ModuleLoader__.load({ id, factory })
```

## 0.2.0 — защита от модели: цель и файлы

В панели над полем ввода две кнопки.

**🎯 Цель** — человек вручную задаёт goal. При включённой защите (`goalLock`)
модель не может менять цель инструментами `create_goal`/`update_goal`:
такие вызовы отклоняются с подсказкой «попросите пользователя нажать кнопку».
Цель ставится напрямую через сервис целей DSH, минуя текстовый канал.

**🗂 Файлы** — список защищённых файлов с галками: `AGENTS.md`/`CLAUDE.md`
рабочей папки, `~/.dsh/AGENTS.md`, `SKILL.md` всех навыков и всё, что дописано
вручную. Отмеченное модель не может изменить ни `write`/`edit`, ни
`bash`-командой записи (`>`, `sed -i`, `cp`, `mv`, `rm`, …). Модель получает
отказ и должна попросить снять галку.

Конфиг: `~/.dsh/auto-press/config.json` (`goalLock`, `protectedPaths`).
RPC: `/api/dsh-auto-press` (`snapshot`, `setGoal`, `setGoalLock`, `setProtected`).
