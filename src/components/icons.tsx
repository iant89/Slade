import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function I({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconPlus = (p: P) => (
  <I {...p}><path d="M12 5v14M5 12h14" /></I>
)
export const IconSend = (p: P) => (
  <I {...p}><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" /></I>
)
export const IconStop = (p: P) => (
  <I {...p}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></I>
)
export const IconCopy = (p: P) => (
  <I {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></I>
)
export const IconCheck = (p: P) => (
  <I {...p}><path d="M20 6 9 17l-5-5" /></I>
)
export const IconRefresh = (p: P) => (
  <I {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></I>
)
export const IconPencil = (p: P) => (
  <I {...p}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></I>
)
export const IconTrash = (p: P) => (
  <I {...p}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></I>
)
export const IconBranch = (p: P) => (
  <I {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M6 8.5v2A3.5 3.5 0 0 0 9.5 14h5a3.5 3.5 0 0 1 3.5 3.5v.5" /><path d="M18 8.5V9" /></I>
)
export const IconGear = (p: P) => (
  <I {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></I>
)
export const IconDownload = (p: P) => (
  <I {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></I>
)
export const IconX = (p: P) => (
  <I {...p}><path d="M18 6 6 18M6 6l12 12" /></I>
)
export const IconChevronDown = (p: P) => (
  <I {...p}><path d="m6 9 6 6 6-6" /></I>
)
export const IconChevronRight = (p: P) => (
  <I {...p}><path d="m9 18 6-6-6-6" /></I>
)
export const IconGrip = (p: P) => (
  <I {...p}><circle cx="9" cy="6" r="1.4" fill="currentColor" /><circle cx="15" cy="6" r="1.4" fill="currentColor" /><circle cx="9" cy="12" r="1.4" fill="currentColor" /><circle cx="15" cy="12" r="1.4" fill="currentColor" /><circle cx="9" cy="18" r="1.4" fill="currentColor" /><circle cx="15" cy="18" r="1.4" fill="currentColor" /></I>
)
export const IconPaperclip = (p: P) => (
  <I {...p}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></I>
)
export const IconImage = (p: P) => (
  <I {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" /></I>
)
export const IconCode = (p: P) => (
  <I {...p}><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></I>
)
export const IconFileText = (p: P) => (
  <I {...p}><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /></I>
)
export const IconTable = (p: P) => (
  <I {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" /></I>
)
export const IconAudio = (p: P) => (
  <I {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></I>
)
export const IconVideo = (p: P) => (
  <I {...p}><path d="m22 8-6 4 6 4V8Z" /><rect x="2" y="6" width="14" height="12" rx="2" /></I>
)
export const IconArchive = (p: P) => (
  <I {...p}><rect x="2" y="3" width="20" height="5" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></I>
)
export const IconFile = (p: P) => (
  <I {...p}><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><path d="M14 2v6h6" /></I>
)
export const IconSun = (p: P) => (
  <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></I>
)
export const IconMoon = (p: P) => (
  <I {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></I>
)
export const IconMonitor = (p: P) => (
  <I {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></I>
)
export const IconAlert = (p: P) => (
  <I {...p}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4M12 17h.01" /></I>
)
export const IconSparkles = (p: P) => (
  <I {...p}><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z" /></I>
)
export const IconZap = (p: P) => (
  <I {...p}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></I>
)
export const IconClock = (p: P) => (
  <I {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></I>
)
export const IconKey = (p: P) => (
  <I {...p}><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3L22 7l-3-3" /></I>
)
export const IconSliders = (p: P) => (
  <I {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></I>
)
export const IconPalette = (p: P) => (
  <I {...p}><circle cx="13.5" cy="6.5" r=".9" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".9" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".9" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".9" fill="currentColor" /><path d="M12 2A10 10 0 0 0 2 12a10 10 0 0 0 10 10 2 2 0 0 0 2-2 2 2 0 0 1 .6-1.4 2 2 0 0 0 .5-1.4 2 2 0 0 0-2-2h-1.6a5.4 5.4 0 0 1-5.4-5.4A6 6 0 0 1 12 4h.4A10 10 0 0 1 22 11.6 8 8 0 0 1 12 2Z" /></I>
)
export const IconDatabase = (p: P) => (
  <I {...p}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></I>
)
export const IconPin = (p: P) => (
  <I {...p}><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></I>
)
export const IconPanelLeft = (p: P) => (
  <I {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></I>
)
export const IconPanelRight = (p: P) => (
  <I {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></I>
)
export const IconExpand = (p: P) => (
  <I {...p}><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></I>
)
export const IconCollapse = (p: P) => (
  <I {...p}><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10l7-7" /><path d="M3 21l7-7" /></I>
)
export const IconArrowDown = (p: P) => (
  <I {...p}><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></I>
)
export const IconLayers = (p: P) => (
  <I {...p}><path d="m12 2 10 6.5L12 15 2 8.5 12 2z" /><path d="m2 15.5 10 6.5 10-6.5" /></I>
)
export const IconWifiOff = (p: P) => (
  <I {...p}><path d="M12 20h.01" /><path d="M8.5 16.4a5 5 0 0 1 7 0" /><path d="M5 12.9a10 10 0 0 1 5.3-2.8" /><path d="M19 12.9a10 10 0 0 0-2-1.6" /><path d="M2 8.8a15 15 0 0 1 4.2-2.7" /><path d="M22 8.8a15 15 0 0 0-9-3.2 15 15 0 0 0-2 .1" /><path d="m2 2 20 20" /></I>
)
export const IconPlay = (p: P) => (
  <I {...p}><path d="m6 4 14 8-14 8V4z" fill="currentColor" stroke="none" /></I>
)
export const IconPause = (p: P) => (
  <I {...p}><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /></I>
)
export const IconMic = (p: P) => (
  <I {...p}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><path d="M12 18v4" /></I>
)
