group "default" {
  targets = ["web", "api", "worker", "migrate"]
}

target "container" {
  context    = "."
  dockerfile = "Dockerfile"
}

target "web" {
  inherits = ["container"]
  target   = "web"
}

target "api" {
  inherits = ["container"]
  target   = "api"
}

target "worker" {
  inherits = ["container"]
  target   = "worker"
}

target "migrate" {
  inherits = ["container"]
  target   = "migrate"
}
