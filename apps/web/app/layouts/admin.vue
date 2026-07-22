<script setup lang="ts">
import { MotionConfig } from "motion-v";
import Button from "primevue/button";
import Drawer from "primevue/drawer";
import Toast from "primevue/toast";

const mobileNavigationOpen = ref(false);
</script>

<template>
  <MotionConfig reduced-motion="user">
    <div class="admin-shell">
      <aside class="admin-sidebar" aria-label="Admin navigation">
        <NuxtLink
          class="brand admin-sidebar__brand"
          to="/admin"
          aria-label="Join The Six admin home"
        >
          <span class="brand__mark" aria-hidden="true" />
          <span>Join The Six</span>
        </NuxtLink>
        <p class="admin-sidebar__kicker">Admin workspace</p>
        <AdminNavigation />
        <div class="admin-sidebar__footer">
          <AdminUserMenu />
          <p class="admin-sidebar__environment">
            <span class="status-dot" aria-hidden="true" />
            <span>Local environment</span>
          </p>
        </div>
      </aside>

      <div class="admin-main">
        <!-- Small screens only: the sidebar (and its operator menu) is hidden,
             so the top bar carries navigation access and the menu instead. -->
        <header class="admin-topbar">
          <div class="admin-topbar__identity">
            <Button
              class="mobile-menu-button"
              icon="pi pi-bars"
              text
              rounded
              aria-label="Open navigation"
              aria-controls="admin-mobile-navigation"
              :aria-expanded="mobileNavigationOpen"
              @click="mobileNavigationOpen = true"
            />
            <div>
              <div class="admin-topbar__eyebrow">Join The Six</div>
              <strong>Control center</strong>
            </div>
          </div>
          <AdminUserMenu />
        </header>

        <main id="main-content" class="admin-content" tabindex="-1">
          <slot />
        </main>
      </div>

      <Drawer
        id="admin-mobile-navigation"
        v-model:visible="mobileNavigationOpen"
        header="Join The Six admin"
        position="left"
      >
        <p class="admin-drawer__note">Local environment</p>
        <AdminNavigation @navigate="mobileNavigationOpen = false" />
      </Drawer>
      <Toast position="bottom-right" />
    </div>
  </MotionConfig>
</template>
