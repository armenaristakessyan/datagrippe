import { useId } from 'react'
import { cn } from '@/lib/cn'

/**
 * DataGrippe app mark — the app icon (build/icon.svg) without its outer shadow: a "DG" monogram on a dark glass
 * panel over a vivid mesh gradient; the G's bar is the gradient "grip".
 */
export function AppMark({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  const ref = (name: string) => `url(#${id}${name})`
  return (
    <svg width={size} height={size} viewBox="100 100 824 824" aria-hidden className={cn('shrink-0', className)}>
      <defs>
        <clipPath id={`${id}tile`}>
          <rect x="100" y="100" width="824" height="824" rx="186" />
        </clipPath>
        <linearGradient id={`${id}base`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4c1d95" />
          <stop offset="0.5" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#be185d" />
        </linearGradient>
        <filter id={`${id}blur`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="95" />
        </filter>
        <filter id={`${id}panel`} x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="20" stdDeviation="24" floodColor="#0b0420" floodOpacity="0.55" />
        </filter>
        <radialGradient id={`${id}sheen`} cx="0.3" cy="0.05" r="0.85">
          <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}glass`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c1733" />
          <stop offset="1" stopColor="#0d0b18" />
        </linearGradient>
        <linearGradient id={`${id}rim`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5ff2c4" stopOpacity="0.85" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#ff6aa9" stopOpacity="0.75" />
        </linearGradient>
        {/* userSpaceOnUse: a gradient on a horizontal stroke (zero-height box) would not render otherwise */}
        <linearGradient id={`${id}grip`} gradientUnits="userSpaceOnUse" x1="610" y1="0" x2="760" y2="0">
          <stop offset="0" stopColor="#14e0a3" />
          <stop offset="0.55" stopColor="#3b8bff" />
          <stop offset="1" stopColor="#ff3d8b" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="186" fill={ref('base')} />
      <g clipPath={ref('tile')}>
        <g filter={ref('blur')}>
          <circle cx="190" cy="210" r="290" fill="#14e0a3" />
          <circle cx="150" cy="650" r="210" fill="#2f86ff" />
          <circle cx="900" cy="910" r="320" fill="#ff3d8b" />
          <circle cx="930" cy="260" r="210" fill="#9b6bff" />
        </g>
        <rect x="100" y="100" width="824" height="824" fill={ref('sheen')} />
      </g>
      <rect x="101.5" y="101.5" width="821" height="821" rx="184.5" fill="none" stroke="#fff" strokeOpacity="0.28" strokeWidth="3" />
      <g filter={ref('panel')}>
        <rect x="232" y="232" width="560" height="560" rx="128" fill={ref('glass')} />
      </g>
      <rect x="234" y="234" width="556" height="556" rx="126" fill="none" stroke={ref('rim')} strokeWidth="4" />
      <g fill="none" strokeWidth="58" strokeLinejoin="round" transform="translate(-21 0)">
        <path d="M330 412 V612 H362 A100 100 0 0 0 362 412 Z" stroke="#fff" />
        <path d="M678.7 441.3 A100 100 0 1 0 708 512" stroke="#fff" strokeLinecap="butt" />
        <path d="M737 512 H624" stroke={ref('grip')} strokeLinecap="round" />
      </g>
    </svg>
  )
}
