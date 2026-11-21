resource "supabase_project" "db" {
  organization_id   = var.supabase_organization_id
  name              = var.supabase_project_name
  database_password = var.supabase_db_password
  region            = var.supabase_region

  lifecycle {
    prevent_destroy = true
  }
}

# Auth, storage and network settings are reviewed in PRs like any other code.
resource "supabase_settings" "auth" {
  project_ref = supabase_project.db.id

  auth = jsonencode({
    site_url                 = "https://${var.vercel_production_domain}"
    jwt_exp                  = 3600
    mailer_autoconfirm       = false
    external_phone_enabled   = true
    security_captcha_enabled = true
  })
}

resource "supabase_settings" "network" {
  project_ref = supabase_project.db.id

  network = jsonencode({
    restrictions = []
  })
}
