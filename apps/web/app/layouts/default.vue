<template>
  <div class="site-shell">
    <header class="site-header">
      <div class="container site-header__inner">
        <NuxtLink class="brand" to="/">Join The Six</NuxtLink>
        <nav class="site-nav" aria-label="Primary navigation">
          <NuxtLink to="/join">Join a dinner</NuxtLink>
          <NuxtLink to="/legal/privacy">Privacy</NuxtLink>
          <NuxtLink to="/admin">Admin</NuxtLink>
        </nav>
      </div>
    </header>
    <main id="main-content">
      <slot />
    </main>
    <footer class="site-footer">
      <div class="container site-footer__inner">
        <span>Join The Six</span>
        <span>Small tables. Better conversations.</span>
      </div>
    </footer>
  </div>
</template>
