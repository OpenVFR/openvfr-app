/** The supporter's round logo (see @open-vfr/shared/sponsor). */
export default function SponsorLogo({ size }: { size: number }) {
  return <img src="/sponsor-sgk.png" alt="" width={size} height={size} style={{ borderRadius: '50%', flexShrink: 0 }} />
}
