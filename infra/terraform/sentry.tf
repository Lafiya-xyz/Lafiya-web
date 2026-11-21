resource "sentry_team" "lafiya" {
  organization = var.sentry_organization
  name         = var.sentry_team
}

resource "sentry_project" "web" {
  organization = var.sentry_organization
  team         = sentry_team.lafiya.slug
  name         = var.sentry_project_name
  platform     = var.sentry_platform

  lifecycle {
    prevent_destroy = true
  }
}

# Alert rules are code so paging behaviour is reviewed in PRs.
resource "sentry_issue_alert" "error_rate" {
  organization = sentry_project.web.organization
  project      = sentry_project.web.slug
  name         = "High error rate"

  action_match = "any"
  filter_match = "all"
  frequency    = 30

  conditions = jsonencode([
    {
      id   = "sentry.rules.conditions.event_frequency.EventFrequencyCondition"
      name = "The issue is seen more than 50 times in 1h"
      interval = "1h"
      value    = 50
    }
  ])

  actions = jsonencode([
    {
      id   = "sentry.mail.actions.NotifyEmailAction"
      name = "Send a notification to the team"
      targetType = "Team"
      targetIdentifier = sentry_team.lafiya.id
    }
  ])
}
