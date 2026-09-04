<script setup lang="ts">
import { computed } from "vue";
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  darkTheme,
  lightTheme,
  dateZhCN,
  zhCN,
} from "naive-ui";
import { darkOverrides, lightOverrides } from "./theme";
import { useSettingsStore } from "./stores/settings";
import AppShell from "./components/AppShell.vue";

const settings = useSettingsStore();
const naiveTheme = computed(() => (settings.appDark ? darkTheme : lightTheme));
const overrides = computed(() => (settings.appDark ? darkOverrides : lightOverrides));
</script>

<template>
  <n-config-provider
    :theme="naiveTheme"
    :theme-overrides="overrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
    style="height: 100%"
  >
    <n-message-provider placement="bottom">
      <n-dialog-provider>
        <AppShell />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
