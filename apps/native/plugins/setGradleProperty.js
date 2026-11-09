/** Upsert a key in the generated android/gradle.properties (withGradleProperties modResults). */
module.exports = function setGradleProperty(props, key, value) {
  const existing = props.find((p) => p.type === 'property' && p.key === key)
  if (existing) existing.value = value
  else props.push({ type: 'property', key, value })
}
