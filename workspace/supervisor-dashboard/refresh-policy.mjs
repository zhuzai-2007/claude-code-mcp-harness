export function refreshDelay(hasRunningWork) {
  return hasRunningWork ? 1000 : 4000;
}
