'use client'

import { createContext, useContext } from 'react'

export const DynamicReadyContext = createContext(false)
export const useDynamicReady = () => useContext(DynamicReadyContext)
