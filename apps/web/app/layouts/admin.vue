<script setup lang="ts">
import { MotionConfig } from "motion-v";

const mobileNavigationOpen = ref(false);
</script>

<template>
  <MotionConfig reduced-motion="user">
    <div class="admin-shell">
      <aside class="admin-sidebar" aria-label="Operations navigation">
        <NuxtLink class="brand admin-sidebar__brand" to="/admin">
          Join The Six
        </NuxtLink>
        <AdminNavigation />
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
              @click="mobileNavigationOpen = true"
            />
            <div>
              <div class="eyebrow">Operations</div>
              <strong>Foundation workspace</strong>
            </div>
          </div>
          <Avatar
            label="J"
            shape="circle"
            aria-label="Signed in as demo operator"
          />
        </header>

        <main id="main-content" class="admin-content">
          <slot />
        </main>
      </div>

      <Drawer
        v-model:visible="mobileNavigationOpen"
        header="Operations navigation"
        position="left"
      >
        <AdminNavigation @navigate="mobileNavigationOpen = false" />
      </Drawer>
      <Toast position="bottom-right" />
    </div>
  </MotionConfig>
</template>
