group "default" {
  targets = ["web", "api", "worker", "migrate"]
}

variable "RELEASE_TAG" {
  default = "local"
}

variable "VITE_CLERK_PUBLISHABLE_KEY" {
  default = ""
}

target "container" {
  context    = "."
  dockerfile = "Dockerfile"
}

target "web" {
  inherits = ["container"]
  target   = "web"
  tags     = ["join-the-six-web:${RELEASE_TAG}"]
  args = {
    VITE_API_BASE              = "/api"
    VITE_CLERK_PUBLISHABLE_KEY = "${VITE_CLERK_PUBLISHABLE_KEY}"
  }
}

target "api" {
  inherits = ["container"]
  target   = "api"
  tags     = ["join-the-six-api:${RELEASE_TAG}"]
}

target "worker" {
  inherits = ["container"]
  target   = "worker"
  tags     = ["join-the-six-worker:${RELEASE_TAG}"]
}

target "migrate" {
  inherits = ["container"]
  target   = "migrate"
  tags     = ["join-the-six-migrate:${RELEASE_TAG}"]
}
