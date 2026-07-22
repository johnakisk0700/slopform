<script setup lang="ts">
import Avatar from "primevue/avatar";
import Button from "primevue/button";
import Popover from "primevue/popover";
import SelectButton from "primevue/selectbutton";
import type { ThemeMode } from "~/composables/useTheme";

const { mode, setMode } = useTheme();

const themeOptions: { label: string; value: ThemeMode; icon: string }[] = [
  { label: "Light", value: "light", icon: "pi pi-sun" },
  { label: "Dark", value: "dark", icon: "pi pi-moon" },
  { label: "Auto", value: "system", icon: "pi pi-desktop" },
];

const panel = ref<InstanceType<typeof Popover> | null>(null);
const open = ref(false);
// The menu renders in the sidebar (desktop) and the top bar (small screens),
// so every id must be instance-unique.
const panelId = useId();
const themeLabelId = useId();

function toggle(event: MouseEvent): void {
  panel.value?.toggle(event);
}

function onThemeChange(value: ThemeMode): void {
  if (value) setMode(value);
}
</script>

<template>
  <div class="admin-user-menu">
    <button
      type="button"
      class="admin-user-menu__trigger"
      aria-label="Account and appearance"
      aria-haspopup="dialog"
      :aria-controls="panelId"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="admin-user-menu__name">Spyridoula</span>
      <!-- Rounded square: the circle motif stays reserved for the brand mark. -->
      <Avatar label="Σ" aria-hidden="true" />
    </button>

    <Popover :id="panelId" ref="panel" @show="open = true" @hide="open = false">
      <div class="admin-user-panel">
        <div class="admin-user-panel__identity">
          <Avatar label="Σ" size="large" aria-hidden="true" />
          <div>
            <strong>Spyridoula</strong>
            <span>Operator</span>
          </div>
        </div>

        <div class="admin-user-panel__section">
          <span :id="themeLabelId" class="admin-user-panel__label">
            Appearance
          </span>
          <SelectButton
            :model-value="mode"
            :options="themeOptions"
            option-value="value"
            :allow-empty="false"
            :aria-labelledby="themeLabelId"
            class="admin-theme-switch"
            @update:model-value="onThemeChange"
          >
            <template #option="{ option }">
              <span :class="option.icon" aria-hidden="true" />
              <span>{{ option.label }}</span>
            </template>
          </SelectButton>
        </div>

        <div class="admin-user-panel__footer">
          <Button
            label="Sign out"
            icon="pi pi-sign-out"
            severity="secondary"
            text
            disabled
          />
          <small>Sign-in arrives with the backend session contract.</small>
        </div>
      </div>
    </Popover>
  </div>
</template>
