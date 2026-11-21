variable "environment" {
  description = "Deployment identity: preview, staging, pilot, production or mainnet."
  type        = string

  validation {
    condition     = contains(["preview", "staging", "pilot", "production", "mainnet"], var.environment)
    error_message = "environment must be one of preview, staging, pilot, production, mainnet."
  }
}

variable "vercel_team_id" {
  description = "Vercel team that owns the project."
  type        = string
}

variable "vercel_project_name" {
  description = "Vercel project name."
  type        = string
  default     = "lafiya-web"
}

variable "vercel_git_repo" {
  description = "GitHub repository connected to the Vercel project."
  type        = string
  default     = "Lafiya-xyz/Lafiya-web"
}

variable "vercel_production_domain" {
  description = "Primary production domain served by Vercel."
  type        = string
  default     = "lafiya.xyz"
}

variable "supabase_organization_id" {
  description = "Supabase organization that owns the project."
  type        = string
}

variable "supabase_project_name" {
  description = "Supabase project name."
  type        = string
}

variable "supabase_region" {
  description = "Supabase project region."
  type        = string
  default     = "eu-central-1"
}

variable "supabase_db_password" {
  description = "Database password for the Supabase project. Supplied from CI secrets."
  type        = string
  sensitive   = true
}

variable "sentry_organization" {
  description = "Sentry organization slug."
  type        = string
}

variable "sentry_project_name" {
  description = "Sentry project slug."
  type        = string
  default     = "lafiya-web"
}

variable "sentry_team" {
  description = "Sentry team that owns the project."
  type        = string
  default     = "lafiya"
}

variable "sentry_platform" {
  description = "Sentry project platform."
  type        = string
  default     = "javascript-nextjs"
}

variable "dns_zone_name" {
  description = "Cloudflare zone (apex domain) that hosts the public DNS records."
  type        = string
  default     = "lafiya.xyz"
}

variable "dns_short_link_domain" {
  description = "Short-link host used by /r/<code> (see docs/adr-004-short-link-domain.md)."
  type        = string
  default     = "lafiya.link"
}

variable "dns_vercel_cname_target" {
  description = "CNAME target Vercel assigns to the project."
  type        = string
  default     = "cname.vercel-dns.com"
}

variable "dns_vercel_a_record" {
  description = "A record target Vercel assigns to the apex domain."
  type        = string
  default     = "76.76.21.21"
}

variable "dns_vercel_txt_verification" {
  description = "TXT verification value Vercel requires for the apex domain."
  type        = string
  sensitive   = true
}

variable "dns_spf_record" {
  description = "SPF policy for the sending domain (see docs/operations/email-deliverability.md)."
  type        = string
  default     = "v=spf1 include:amazonses.com -all"
}

variable "dns_dmarc_policy" {
  description = "DMARC policy for the sending domain."
  type        = string
  default     = "v=DMARC1; p=quarantine; rua=mailto:dmarc@lafiya.xyz"
}

variable "app_env" {
  description = "Non-secret application variables per Vercel target. Keys must exist in lib/env.ts or lib/runtime-config.ts."
  type        = map(map(string))
  default     = {}
}

variable "app_secrets" {
  description = "Secret application variables per Vercel target. Values come from CI secrets; never commit them."
  type        = map(map(string))
  sensitive   = true
  default     = {}
}
