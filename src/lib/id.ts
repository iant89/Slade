import { nanoid } from 'nanoid'

export const uid = (prefix = ''): string => (prefix ? `${prefix}_` : '') + nanoid(12)
