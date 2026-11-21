terraform {
  required_version = ">= 1.9.0"

  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 2.0"
    }
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.0"
    }
    sentry = {
      source  = "jianyuan/sentry"
      version = "~> 0.14"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  # Remote, locked and encrypted state. The bucket is versioned and
  # object-locked; credentials come from the CI environment, never from code.
  backend "s3" {
    bucket       = "lafiya-terraform-state"
    key          = "lafiya-web/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
