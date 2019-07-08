module.exports = class AbortError extends Error {
  name = 'AbortError'
  isAbortError = true
}
