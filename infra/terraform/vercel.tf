locals {
  # Vercel targets managed as code. Preview credentials are injected per PR by
  # .github/workflows/preview.yml and are intentionally not managed here.
  targets = ["production", "preview"]

  common_env = {
    LAFIYA_DEPLOYMENT_ENV = var.environment
  }
}

resource "vercel_project" "web" {
  name      = var.vercel_project_name
  framework = "nextjs"
  team_id   = var.vercel_team_id

  git_repository = {
    type = "github"
    repo = var.vercel_git_repo
  }

  # vercel.json is generated from lib/ops/schedules.json (issue #693); the
  # dashboard must not override it.
  build_command    = "npm run build"
  install_command  = "npm ci"
  output_directory = ".next"

  # Platform settings are reviewed in PRs, so dashboard edits are reverted.
  ignore_command = "git diff --quiet HEAD^ HEAD -- . ':!docs' ':!**/*.md'"

  lifecycle {
    prevent_destroy = true
  }
}

resource "vercel_project_domain" "production" {
  project_id = vercel_project.web.id
  domain     = var.vercel_production_domain
  team_id    = var.vercel_team_id
}

resource "vercel_project_environment_variable" "plain" {
  for_each = {
    for pair in setproduct(local.targets, keys(local.common_env)) :
    "${pair[0]}:${pair[1]}" => { target = pair[0], key = pair[1] }
  }

  project_id = vercel_project.web.id
  team_id    = var.vercel_team_id
  key        = each.value.key
  value      = local.common_env[each.value.key]
  target     = [each.value.target]
  sensitive  = false
}

resource "vercel_project_environment_variable" "app" {
  for_each = {
    for pair in flatten([
      for target, values in var.app_env : [
        for key, value in values : { target = target, key = key, value = value }
      ]
    ]) : "${pair.target}:${pair.key}" => pair
  }

  project_id = vercel_project.web.id
  team_id    = var.vercel_team_id
  key        = each.value.key
  value      = each.value.value
  target     = [each.value.target]
  sensitive  = false
}

resource "vercel_project_environment_variable" "secret" {
  for_each = {
    for pair in flatten([
      for target, values in var.app_secrets : [
        for key, value in values : { target = target, key = key, value = value }
      ]
    ]) : "${pair.target}:${pair.key}" => pair
  }

  project_id = vercel_project.web.id
  team_id    = var.vercel_team_id
  key        = each.value.key
  value      = each.value.value
  target     = [each.value.target]
  sensitive  = true
}
