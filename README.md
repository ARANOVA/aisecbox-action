# aisecbox-action

Composite action para aplicar un **plan de parches de dependencias de AiSecBox**
con `aisecbox-cli` desde cualquier workflow de GitHub Actions, incluidos los
repos públicos.

En una sola step:

- instala el último `aisecbox-cli` publicado para el runner y verifica su
  checksum;
- aplica el plan sobre los manifiestos del repo (o lo previsualiza con
  `dry_run: true`);
- deja el binario en el `PATH` de los steps siguientes;
- expone qué ficheros cambiaron y, si quieres, deja que el CLI abra el PR con
  `create_pr: true`.

La action **no** genera el plan, **no** refresca lockfiles y **no** ejecuta
tests ni build: eso lo hace el workflow que la usa. El patrón recomendado es
*aplicar → validar → PR*.

## Uso mínimo

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
  run: npm test   # los comandos de tu stack
```

La configuración no sensible va en `with:`; los secretos, siempre en el `env:`
de la step.

## Requisitos

- Un proyecto dado de alta en AiSecBox y su `AISECBOX_API_KEY`. La key es del
  proyecto/repo que se parchea, no de este repo.
- Al menos una ejecución de `aisecbox-cli scan dependencies` desde la raíz de
  ese repo: el gateway genera el plan a partir de esa ejecución.
- Un `aisecbox-cli` que incluya `patch apply` (**v1.1.0 o posterior**). La
  action comprueba `patch --help` después de instalar y falla con un mensaje
  explícito si la release publicada no lo incluye.
- El job debe hacer `actions/checkout` antes de la action: el plan se aplica
  sobre el working copy y los cambios se detectan con `git status`.
- Node 18+ en el runner (los runners de GitHub lo traen).
- Permisos del workflow llamador:
  - `contents: read` si solo aplicas los cambios y el commit lo haces tú.
  - `contents: write` y `pull-requests: write` con `create_pr: true` o si el
    propio workflow abre el PR.

## Flujo recomendado: aplicar → validar → PR

Los tests corren **antes** de abrir el PR, así que el PR nace verde.

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

      - name: Apply AiSecBox patch plan
        id: aisecbox
        uses: aranova/aisecbox-action@v1
        with:
          plan: https://cloud.service.aranova.cloud/api/v1/aisecbox/cli/patch
        env:
          AISECBOX_API_KEY: ${{ secrets.AISECBOX_API_KEY }}

      # El CLI no toca lockfiles: refresca los tuyos si el plan cambió manifiestos.
      - name: Refresh lockfiles
        if: steps.aisecbox.outputs.changed == 'true'
        run: npm install --package-lock-only --ignore-scripts

      - name: Test
        if: steps.aisecbox.outputs.changed == 'true'
        run: npm ci && npm test

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
            --body "Aplicado con aisecbox-action. Tests verdes en esta rama."
```

Comandos equivalentes según el stack (los del workflow son tuyos, la action no
los ejecuta):

| Stack | Refrescar lockfiles | Build y tests (ejemplos) |
| --- | --- | --- |
| Node / npm | `npm install --package-lock-only --ignore-scripts` | `npm ci && npm test` |
| Go | `go mod tidy` | `go build ./...` y `go test ./...` |
| Python / uv | `uv lock` | `uv run pytest` |

Si `changed` es `false`, el plan no modificó nada (por ejemplo, ya estaba
aplicado): los pasos con `if:` se omiten y no se abre PR.

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

Una sola step, pero con salvedades:

- El PR se abre **antes** de que el workflow pueda ejecutar tests o build.
- Los PRs creados con `GITHUB_TOKEN` **no disparan** workflows `pull_request`
  (GitHub no emite el evento para evitar bucles). Si quieres CI en el PR, usa un
  PAT/GitHub App o el patrón *aplicar → validar → PR*.
- Requiere `contents: write` y `pull-requests: write`, y que el repo permita
  crear PRs con `GITHUB_TOKEN` (*Settings → Actions → General → Allow GitHub
  Actions to create and approve pull requests*) o usar un PAT/GitHub App.
- Solo crea PRs en **GitHub.com**; no en GitHub Enterprise.
- Los cambios se escriben también en el árbol de trabajo, pero rama, commit y
  PR se crean vía API: no hace falta commitear nada después.
- Con `dry_run: true` el flag `create_pr` se ignora.

## Inputs

| Input | Defecto | Qué hace |
| --- | --- | --- |
| `plan` | — (obligatorio) | Plan a aplicar: ruta relativa a `working_directory` o URL HTTPS del gateway. |
| `dry_run` | `false` | Previsualiza los cambios sin escribir ficheros, sin PR y sin reportar el resultado al gateway. |
| `overrides` | `auto` | `auto` aplica los overrides del plan; `never` los omite todos. |
| `create_pr` | `false` | Deja que el CLI cree rama, commit y PR (requiere `GITHUB_TOKEN`/`GH_TOKEN`). |
| `working_directory` | `.` | Directorio de ejecución relativo a la raíz del repo (útil en monorepos). |
| `debug` | `false` | Activa `AISECBOX_CLI_DEBUG=1`. **No usar en repos públicos.** |
| `base_url` | `https://aisecbox.com/downloads` | Mirror de artefactos con el mismo layout (`artifacts.json` incluido). |

Notas:

- El CLI solo acepta `plan` por HTTPS desde `aisecbox.com`, `*.aisecbox.com` y
  `cloud.service.aranova.cloud`.
- `dry_run: true` con un plan local no necesita `AISECBOX_API_KEY`; con URL
  HTTPS sí, porque el plan se descarga autenticado.
- La action valida `overrides`, `dry_run` y `create_pr` antes de ejecutar y
  falla si no son valores admitidos.

## Outputs

| Output | Contenido |
| --- | --- |
| `changed` | `true` si el plan modificó ficheros. |
| `changed_files` | Rutas modificadas (relativas a la raíz del repo), separadas por saltos de línea. |
| `applied` | Nº de parches aplicados (vacío si no se pudo parsear la salida del CLI). |
| `skipped` | Nº de parches omitidos (vacío si no se pudo parsear). |
| `pr_url` | URL del PR cuando `create_pr: true`. |

`changed` se calcula comparando `git status` antes y después de aplicar el plan,
así que solo ve ficheros ya trackeados. Para `changed_files` en bash:

```bash
printf '%s\n' "${{ steps.aisecbox.outputs.changed_files }}"
```

## Secretos y variables de entorno

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `AISECBOX_API_KEY` | Sí, para URL o apply real | Autenticar la descarga del plan, el apply y el reporte del resultado. |
| `GITHUB_TOKEN` / `GH_TOKEN` | Solo con `create_pr: true` | Crear rama, commit y PR en GitHub.com. |
| `AISECBOX_CLI_DEBUG` | No | Equivale a `debug: true`. |

GitHub enmascara los secretos registrados en los logs, pero el modo debug del
CLI imprime cabeceras y payloads: en un repo público esos logs son públicos.

## Repos públicos

- **Los secretos no llegan a los forks.** Si el workflow se dispara con
  `pull_request` desde un fork, `AISECBOX_API_KEY` no existe y la action falla.
  Usa `workflow_dispatch`, `schedule` o `push` sobre una rama del repo; evita
  `pull_request_target` con código no confiable.
- **Fija la action por SHA** si te preocupa la cadena de suministro
  (`uses: aranova/aisecbox-action@<sha>`); `v1` es un tag móvil.
- El binario se descarga por HTTPS y la action verifica el SHA-256 publicado en
  `artifacts.json` (si el mirror no publica checksum, avisa y continúa). La
  action no embebe secretos ni compila nada: es `action.yml` más un instalador
  Node pequeño, auditable.

## Problemas frecuentes

| Mensaje | Causa y solución |
| --- | --- |
| `The installed aisecbox-cli (...) does not include 'patch apply'` | La release publicada es anterior a v1.1.0. Publica una release con `patch apply` o apunta `base_url` a un mirror con una versión más reciente. |
| `AISECBOX_API_KEY is required to fetch or apply a plan` | Falta el secreto en el `env:` de la step, o usas una URL HTTPS con `dry_run: true`. |
| `input 'plan' is required` / `working_directory '<x>' does not exist` | Revisa los `with:` de la step. |
| `Checksum mismatch for <artifact>` | Descarga corrupta o mirror desactualizado. |
| `No aisecbox-cli artifact published for <os>/<arch>` | El runner no está soportado (Linux, macOS y Windows sí). |
| `changed` es `false` aunque esperabas cambios | El plan ya estaba aplicado, sus cambios son de versión major (se omiten a propósito) o los overrides no aplican. Revisa el log: la action imprime `Applied … skipped …`. Solo se detectan ficheros trackeados por git. |

## Desarrollo

El workflow [`validate.yml`](.github/workflows/validate.yml) comprueba en cada
push y PR la sintaxis del instalador (`node --check`) y que `action.yml` sea una
composite action con los inputs esperados y los `run:` válidos.

Para publicar una versión nueva: tag de versión (`v1.0.0`, `v1.1.0`…) y mover el
tag móvil de major (`v1`) al mismo commit.

## Licencia

Apache-2.0. Ver [LICENSE](LICENSE).
