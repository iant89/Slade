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
/** The Slade mark: a rounded eight-ray starburst (Claude-style asterisk). */
export const IconStarburst = (p: P) => (
  <I {...p} strokeWidth={2.5}>
    <path d="M12 2.8v18.4" />
    <path d="M2.8 12h18.4" />
    <path d="M5.7 5.7l12.6 12.6" />
    <path d="M18.3 5.7 5.7 18.3" />
  </I>
)
export const IconArrowUp = (p: P) => (
  <I {...p}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></I>
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
export const IconArchiveRestore = (p: P) => (
  <I {...p}>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h2" />
    <path d="M20 8v11a2 2 0 0 1-2 2h-2" />
    <path d="m9 15 3-3 3 3" />
    <path d="M12 12v9" />
  </I>
)
export const IconArchiveExport = (p: P) => (
  <I {...p}>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M12 20V11" />
    <path d="m8 15 4-4 4 4" />
  </I>
)
export const IconMoreHorizontal = (p: P) => (
  <I {...p}>
    <circle cx="5" cy="12" r="1.3" fill="currentColor" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    <circle cx="19" cy="12" r="1.3" fill="currentColor" />
  </I>
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
export const IconBot = (p: P) => (
  <I {...p}>
    <path d="M12 8V4" /><rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M2 14h2M20 14h2" /><path d="M9 13v2M15 13v2" />
  </I>
)
export const IconRoute = (p: P) => (
  <I {...p}>
    <circle cx="6" cy="19" r="3" /><circle cx="18" cy="5" r="3" />
    <path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H12" />
  </I>
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

/* ---------- GitHub ---------- */

/** The GitHub mark: solid, so it keeps its shape at 12px. */
export const IconGithub = ({ size = 16, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...rest}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
)
export const IconGitCommit = (p: P) => (
  <I {...p}><circle cx="12" cy="12" r="3.2" /><path d="M2.5 12h6.3M15.2 12h6.3" /></I>
)
export const IconRepo = (p: P) => (
  <I {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></I>
)
export const IconSearch = (p: P) => (
  <I {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" /></I>
)
export const IconExternal = (p: P) => (
  <I {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" /></I>
)
export const IconUpload = (p: P) => (
  <I {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 8 5-5 5 5" /><path d="M12 3v12" /></I>
)
export const IconLock = (p: P) => (
  <I {...p}><rect x="3.5" y="11" width="17" height="10" rx="2" /><path d="M7.5 11V7a4.5 4.5 0 0 1 9 0v4" /></I>
)
export const IconStar = (p: P) => (
  <I {...p}><path d="m12 3 2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.85 6.2 20.9l1.1-6.45-4.7-4.6 6.5-.95L12 3z" /></I>
)
export const IconLoader = (p: P) => (
  <I {...p} className={`spin${p.className ? ` ${p.className}` : ''}`}>
    <path d="M12 3v3.5M12 17.5V21M5.6 5.6l2.5 2.5M15.9 15.9l2.5 2.5M3 12h3.5M17.5 12H21M5.6 18.4l2.5-2.5M15.9 8.1l2.5-2.5" />
  </I>
)
export const IconFolder = (p: P) => (
  <I {...p}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </I>
)
/** A question in a circle — the agent asking the user to choose. */
export const IconQuestion = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </I>
)
export const IconBrain = (p: P) => (
  <I {...p}>
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04" />
  </I>
)

