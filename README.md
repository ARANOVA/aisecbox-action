# aisecbox-action

Composite action para aplicar un **plan de parches de dependencias de AiSecBox**
con `aisecbox-cli` desde cualquier workflow de GitHub Actions, incluidos repos
públicos.

Una step con `with:` para la configuración no sensible y `env:` para los secretos.

```yaml
- name: Apply AiSecBox patch plan
  id: aisecbox
  uses: aranova/aisecbox-action@v1
  with:
    plan: https://cloud.service.aranova.cloud/api/v1/aisecbox/cli/patch
  env:
    AISECBOX_API_KEY: ${{ secrets.AISECBOX_API_KEY }}

- name: Test
  if: steps.aisecbox.outputs.changed == 'true'
  run: go test ./...
```

La action **aplica** el plan; no ejecuta tests, build ni abre un PR salvo que se
lo pidas con `create_pr: true`. Para el flujo completo con gate, el patrón
recomendado es `apply -> test/build -> commit + PR` (ver más abajo).

## Requisitos

- Un proyecto dado de alta en AiSecBox y su `AISECBOX_API_KEY` (la key es del
  proyecto/repo que se parchea, no del repo de la action).
- Haber ejecutado `aisecbox-cli scan dependencies` desde la raíz de ese repo
  para que el gateway tenga una ejecución con la que generar el plan.
- Permisos del workflow llamador:
  - `contents: read` si solo aplicas y tú haces el commit.
  - `contents: write` y `pull-requests: write` si usas `create_pr: true`.
- Node 18+ en el runner (los runners de GitHub lo traen). La action descarga el
  binario del CLI para Linux/macOS/Windows y verifica el SHA-256 de
  `artifacts.json`.

## Flujo recomendado: apply -> test -> PR

Así los tests corren **antes** de abrir el PR y el PR nace verde.

```yaml
name: Patch dependencies

on:
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  patch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0

      - name: Apply AiSecBox patch plan
        id: aisecbox
        uses: aranova/aisecbox-action@v1
        with:
          plan: https://cloud.service.aranova.cloud/api/v1/aisecbox/cli/patch
        env:
          AISECBOX_API_KEY: ${{ secrets.AISECBOX_API_KEY }}

      - name: Refresh lockfiles
        if: steps.aisecbox.outputs.changed == 'true'
        run: go mod tidy

      - name: Test
        if: steps.aisecbox.outputs.changed == 'true'
        run: go test ./...

      - name: Build
        if: steps.aisecbox.outputs.changed == 'true'
        run: go build ./...

      - name: Open pull request
        if: steps.aisecbox.outputs.changed == 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          BRANCH: aisecbox/patch-${{ github.run_id }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git switch -c "$BRANCH"
          git add -A
          git commit -m "chore(deps): apply AiSecBox patch plan"
          git push --force origin "$BRANCH"
          gh pr create --base "${{ github.ref_name }}" --head "$BRANCH" \
            --title "chore(deps): apply AiSecBox patch plan" \
            --body "Aplicado con aisecbox-action. Tests y build verdes en esta rama."
```

## Atajo: que el CLI abra el PR

```yaml
- uses: aranova/aisecbox-action@v1
  with:
    plan: https://cloud.service.aranova.cloud/api/v1/aisecbox/cli/patch
    create_pr: "true"
  env:
    AISECBOX_API_KEY: ${{ secrets.AISECBOX_API_KEY }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

El CLI crea rama, commit y PR vía API. Ventaja: una sola step. Inconvenientes:

- El PR se abre **antes** de que el workflow pueda ejecutar tests/build.
- Los PRs abiertos con `GITHUB_TOKEN` **no disparan** workflows `pull_request`
  (GitHub no lanza eventos para evitar bucles). Si quieres CI en el PR, usa un
  PAT/GitHub App o el patrón `apply -> test -> PR`.
- Necesita `contents: write` y `pull-requests: write`.

## Inputs

| Input | Defecto | Descripción |
| --- | --- | --- |
| `plan` | — (obligatorio) | URL HTTPS del gateway o ruta relativa al repo. |
| `dry_run` | `false` | Previsualiza sin escribir. |
| `overrides` | `auto` | `auto` o `never` (modo `--overrides` del CLI). |
| `create_pr` | `false` | Deja que el CLI abra el PR (requiere token y permisos). |
| `working_directory` | `.` | Directorio de ejecución relativo a la raíz del repo. |
| `debug` | `false` | Activa `AISECBOX_CLI_DEBUG=1`. **No usar en repos públicos.** |
| `base_url` | `https://aisecbox.com/downloads` | Mirror de artefactos con el mismo layout. |

## Outputs

| Output | Descripción |
| --- | --- |
| `changed` | `true` si el plan modificó ficheros. |
| `changed_files` | Rutas modificadas, separadas por saltos de línea. |
| `applied` | Nº de parches aplicados (vacío si no se pudo parsear la salida). |
| `skipped` | Nº de parches omitidos (vacío si no se pudo parsear). |
| `pr_url` | URL del PR cuando `create_pr: true`. |

Los outputs multilínea (`changed_files`) se deben consumir con cuidado; en bash:
`printf '%s\n' "${{ steps.aisecbox.outputs.changed_files }}"`.

## Secretos y variables de entorno

Los secretos **nunca** van en `with:` (los inputs quedan visibles en la
definición del workflow). Se pasan en el `env` de la step que usa la action:

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `AISECBOX_API_KEY` | Sí (para URL o apply real) | Autenticar `patch apply` y el `patch-completion`. |
| `GITHUB_TOKEN` / `GH_TOKEN` | Solo con `create_pr: true` | Crear rama, commit y PR (GitHub.com). |
| `AISECBOX_CLI_DEBUG` | No | Equivale a `debug: true`. Evítalo en repos públicos. |

GitHub enmascara los secretos registrados en los logs, pero el modo debug del
CLI imprime cabeceras y payloads; en un repo público los logs son públicos.

## Repos públicos: lo que hay que tener en cuenta

- **Los secretos no llegan a los forks.** Si el workflow se dispara con
  `pull_request` desde un fork, `AISECBOX_API_KEY` no está disponible y la
  action falla. Usa `workflow_dispatch`, `schedule` o `push` sobre una rama
  protegida; evita `pull_request_target` con código no confiable.
- **PR creado con `GITHUB_TOKEN` no dispara CI.** Usa un PAT/GitHub App o el
  patrón `apply -> test -> PR` (los tests corren antes de abrir el PR).
- **Fija la action por SHA** si te preocupa la cadena de suministro:
  `uses: aranova/aisecbox-action@<sha>`; `@v1` es un tag móvil.
- El binario se descarga por HTTPS y se verifica el SHA-256 publicado en
  `artifacts.json`. No hay secretos embebidos en la action.
- La action instala la **última release publicada** del CLI. Si necesitas una
  versión concreta, usa `base_url` con un mirror versionado o compila el CLI en
  tu workflow.
