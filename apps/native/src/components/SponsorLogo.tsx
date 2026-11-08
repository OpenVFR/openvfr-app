import React from 'react'
import { Image } from 'react-native'

/** The supporter's round logo (see @open-vfr/shared/sponsor). */
export function SponsorLogo({ size }: { size: number }) {
  return (
    <Image
      source={require('../../assets/sponsor-sgk.png')}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      accessible={false}
    />
  )
}
