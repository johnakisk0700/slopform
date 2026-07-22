group "default" {
  targets = ["web", "api", "worker", "migrate"]
}

variable "RELEASE_TAG" {
  default = "local"
}

target "container" {
  context    = "."
  dockerfile = "Dockerfile"
}

target "web" {
  inherits = ["container"]
  target   = "web"
  tags     = ["join-the-six-web:${RELEASE_TAG}"]
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
