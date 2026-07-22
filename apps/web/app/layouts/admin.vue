<script setup lang="ts">
import { MotionConfig } from "motion-v";
import Avatar from "primevue/avatar";
import Drawer from "primevue/drawer";
import Toast from "primevue/toast";

const mobileNavigationOpen = ref(false);
</script>

<template>
  <MotionConfig reduced-motion="user">
    <div class="admin-shell">
      <aside class="admin-sidebar" aria-label="Operations navigation">
        <NuxtLink
          class="brand admin-sidebar__brand"
          to="/admin"
          aria-label="Join The Six operations home"
        >
          <span class="brand__mark" aria-hidden="true" />
          <span>Join The Six</span>
        </NuxtLink>
        <p class="admin-sidebar__kicker">Operations workspace</p>
        <AdminNavigation />
        <div class="admin-sidebar__footer">
          <span class="status-dot" aria-hidden="true" />
          Preview environment
        </div>
      </aside>

      <div class="admin-main">
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
              <strong>Operations</strong>
            </div>
          </div>
          <div class="admin-topbar__operator">
            <span>Demo operator</span>
            <Avatar
              label="J"
              shape="circle"
              aria-label="Signed in as demo operator"
            />
          </div>
        </header>

        <main id="main-content" class="admin-content" tabindex="-1">
          <slot />
        </main>
      </div>

      <Drawer
        id="admin-mobile-navigation"
        v-model:visible="mobileNavigationOpen"
        header="Join The Six operations"
        position="left"
      >
        <p class="admin-drawer__note">Preview environment</p>
        <AdminNavigation @navigate="mobileNavigationOpen = false" />
      </Drawer>
      <Toast position="bottom-right" />
    </div>
  </MotionConfig>
</template>
