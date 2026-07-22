<template>
  <div class="site-shell">
    <header class="site-header">
      <div class="container site-header__inner">
        <NuxtLink class="brand" to="/" aria-label="Join The Six home">
          <span class="brand__mark" aria-hidden="true" />
          <span>Join The Six</span>
        </NuxtLink>
        <nav class="site-nav" aria-label="Primary navigation">
          <NuxtLink to="/join">Join a dinner</NuxtLink>
          <NuxtLink to="/legal/terms">Participation</NuxtLink>
          <NuxtLink class="site-nav__admin" to="/admin">Operations</NuxtLink>
        </nav>
      </div>
    </header>
    <main id="main-content" tabindex="-1">
      <slot />
    </main>
    <footer class="site-footer">
      <div class="container site-footer__inner">
        <div>
          <strong>Join The Six</strong>
          <span>Small tables. Better conversations.</span>
        </div>
        <nav class="site-footer__nav" aria-label="Legal navigation">
          <NuxtLink to="/legal/privacy">Privacy</NuxtLink>
          <NuxtLink to="/legal/terms">Terms</NuxtLink>
        </nav>
      </div>
    </footer>
  </div>
</template>
