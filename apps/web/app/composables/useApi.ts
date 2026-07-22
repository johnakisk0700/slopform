export function useApi(): typeof $fetch {
  return useNuxtApp().$api;
}
