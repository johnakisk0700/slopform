group "default" {
  targets = ["web", "api", "worker", "migrate"]
}

variable "RELEASE_TAG" {
  default = "local"
}

variable "VITE_CLERK_PUBLISHABLE_KEY" {
  default = ""
}

variable "VITE_GOOGLE_MAPS_API_KEY" {
  default = ""
}

variable "WEB_PUBLIC_CONFIG_SHA256" {
  default = "unconfigured"
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
    RELEASE_TAG               = "${RELEASE_TAG}"
    WEB_PUBLIC_CONFIG_SHA256  = "${WEB_PUBLIC_CONFIG_SHA256}"
    VITE_API_BASE              = "/api"
    VITE_CLERK_PUBLISHABLE_KEY = "${VITE_CLERK_PUBLISHABLE_KEY}"
    VITE_GOOGLE_MAPS_API_KEY   = "${VITE_GOOGLE_MAPS_API_KEY}"
  }
}

target "api" {
  inherits = ["container"]
  target   = "api"
  tags     = ["join-the-six-api:${RELEASE_TAG}"]
  args = {
    RELEASE_TAG = "${RELEASE_TAG}"
  }
}

target "worker" {
  inherits = ["container"]
  target   = "worker"
  tags     = ["join-the-six-worker:${RELEASE_TAG}"]
  args = {
    RELEASE_TAG = "${RELEASE_TAG}"
  }
}

target "migrate" {
  inherits = ["container"]
  target   = "migrate"
  tags     = ["join-the-six-migrate:${RELEASE_TAG}"]
  args = {
    RELEASE_TAG = "${RELEASE_TAG}"
  }
}
