# CI runners and caching

## Which runner a job uses

| Job kind | Runner |
| --- | --- |
| Heavy Rust jobs (`check`, `platform-base`, anything that compiles the workspace) | oryxa-a1 when the repository variable `A1_RUNNERS` is `true`, GitHub-hosted otherwise |
| Light jobs (`deny`, `sandbox`, schema and OpenTofu validation, the web app) | Always GitHub-hosted |
| Release and deploy builds (`deploy-api`'s `build`) | Always GitHub-hosted, with no sccache, no restored cache and a fresh `CARGO_HOME` |

Release and deploy builds never run on a1 or use shared caches. An a1 runner keeps one `CARGO_HOME`
and sccache store for every PR's CI, so a PR could plant a tampered crate there for the next deploy
to ship. A release build compiles everything from the registry on a clean hosted runner instead.

Heavy jobs use this expression, so one variable moves them between a1 and GitHub-hosted:

```yaml
runs-on: ${{ vars.A1_RUNNERS == 'true' && fromJSON('["self-hosted","oryxa-a1"]') || 'ubuntu-latest' }}
```

Every job must work on both: service containers on random host ports, containers named with the
run id and removed in an `if: always()` step, and nothing left behind on the runner.

## Caching

| What | Hosted runners | oryxa-a1 |
| --- | --- | --- |
| Compiled Rust crates | sccache in the GitHub Actions cache | sccache on local disk, one store per runner (`~/.cache/sccache/<runner>`) |
| Cargo registry and git deps | rust-cache, targets off | `CARGO_HOME` stays on the machine |
| Build output | fresh each run | `target/` cleared each run (a cancelled build leaves it corrupt) |
| pnpm store (`fde-web`) | `actions/setup-node` with `cache: pnpm` | the same |
| npm (`sandbox/*`) | `actions/setup-node` with `cache: npm` | the same |
| OpenTofu providers | `actions/cache` on `TF_PLUGIN_CACHE_DIR` | `TF_PLUGIN_CACHE_DIR` under `$HOME/.cache` |
| Docker images | pulled each run | kept by the machine's Docker |

Rust jobs get all of this from one step after the toolchain: `- uses: ./.github/actions/rust-cache`.

## Registering the a1 runners

The repos live on a personal account, so runners cannot be shared between repos: each repo needs its
own runner instances. Run one instance per directory on the a1 machine, as the user that owns Docker
there. Two instances per repo let two jobs run at once.

1. Get a registration token (valid one hour) on any machine where `gh` is signed in:

```bash
gh api -X POST repos/Shubham04-oss/oryxa-fde/actions/runners/registration-token --jq .token
```

2. On a1, for each instance (`1`, `2`):

```bash
N=1; mkdir -p ~/runners/oryxa-fde-$N && cd ~/runners/oryxa-fde-$N
V=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | sed -n 's/.*"tag_name": "v\([^"]*\)".*/\1/p')
curl -fsSLo runner.tgz "https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-arm64-$V.tar.gz" && tar xzf runner.tgz
./config.sh --url https://github.com/Shubham04-oss/oryxa-fde --token "<token from step 1>" --name "oryxa-a1-fde-$N" --labels oryxa-a1 --unattended
sudo ./svc.sh install && sudo ./svc.sh start
```

3. Once at least one runner shows as online, turn the switch on:

```bash
gh variable set A1_RUNNERS --body true -R Shubham04-oss/oryxa-fde
```

Set it back to `false` to send every job to GitHub-hosted runners, for example while a1 is down.
Jobs aimed at a1 with no runner online wait in the queue and are cancelled after a day.

**To share one runner pool across repos,** move them into the `Oryxa-Vault` organisation and
register the runners there once, for every repo.
