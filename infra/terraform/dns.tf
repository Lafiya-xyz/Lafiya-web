data "cloudflare_zone" "public" {
  name = var.dns_zone_name
}

resource "cloudflare_record" "apex" {
  zone_id = data.cloudflare_zone.public.id
  name    = "@"
  type    = "A"
  content = var.dns_vercel_a_record
  proxied = true
  ttl     = 1
}

resource "cloudflare_record" "www" {
  zone_id = data.cloudflare_zone.public.id
  name    = "www"
  type    = "CNAME"
  content = var.dns_vercel_cname_target
  proxied = true
  ttl     = 1
}

resource "cloudflare_record" "vercel_verification" {
  zone_id = data.cloudflare_zone.public.id
  name    = "_vercel"
  type    = "TXT"
  content = var.dns_vercel_txt_verification
  ttl     = 1
}

resource "cloudflare_record" "spf" {
  zone_id = data.cloudflare_zone.public.id
  name    = "@"
  type    = "TXT"
  content = var.dns_spf_record
  ttl     = 1
}

resource "cloudflare_record" "dmarc" {
  zone_id = data.cloudflare_zone.public.id
  name    = "_dmarc"
  type    = "TXT"
  content = var.dns_dmarc_policy
  ttl     = 1
}

# Short-link host for /r/<code> (docs/adr-004-short-link-domain.md).
resource "cloudflare_record" "short_link" {
  zone_id = data.cloudflare_zone.public.id
  name    = var.dns_short_link_domain
  type    = "CNAME"
  content = var.dns_vercel_cname_target
  proxied = true
  ttl     = 1
}
