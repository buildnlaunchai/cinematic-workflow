'use client'

// The small UI kit the review pages use, lifted from the source app's shared
// constants — self-contained (React + Tailwind + two lucide icons), no ERP deps.

import React from 'react'
import { X, AlertCircle } from 'lucide-react'

export const Card = React.forwardRef<
  HTMLDivElement,
  { children?: React.ReactNode; className?: string; onClick?: (e: React.MouseEvent) => void; style?: React.CSSProperties }
>(({ children, className = '', onClick, style }, ref) => (
  <div
    ref={ref}
    onClick={onClick}
    style={style}
    className={`bg-white dark:bg-slate-800 rounded-[1.5rem] shadow-sm border border-gray-100 dark:border-slate-800/50 p-6 ${className}`}
  >
    {children}
  </div>
))
Card.displayName = 'Card'

export const Badge: React.FC<{ children?: React.ReactNode; colorClass: string; className?: string }> = ({
  children,
  colorClass,
  className = '',
}) => (
  <span className={`px-2.5 py-0.5 rounded-full text-xs font-black uppercase tracking-tighter border ${colorClass} ${className}`}>
    {children}
  </span>
)

export const Modal: React.FC<{
  isOpen: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  maxWidth?: string
  noBlur?: boolean
}> = ({ isOpen, onClose, title, children, maxWidth = 'max-w-md', noBlur = false }) => {
  if (!isOpen) return null
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      // noBlur drops backdrop-filter: a <video> descendant of a backdrop-filtered
      // element renders black in Chrome (compositing bug). Use it for video modals.
      className={`fixed inset-0 z-[300] flex items-center justify-center p-4 md:p-6 bg-black/40 ${noBlur ? '' : 'backdrop-blur-sm'} animate-in fade-in duration-200 cursor-pointer`}
    >
      <Card
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${maxWidth} p-0 overflow-hidden shadow-2xl animate-in zoom-in duration-300 cursor-default flex flex-col max-h-[90vh] bg-white dark:bg-slate-800 border-none`}
      >
        <div className="p-4 border-b border-gray-50 dark:border-slate-800/50 flex justify-between items-center bg-white dark:bg-slate-800 shrink-0">
          <h2 className="text-xs font-bold text-gray-900 dark:text-slate-200 uppercase tracking-widest">{title}</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-200 dark:hover:bg-slate-800 rounded-lg transition-colors text-gray-400">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </Card>
    </div>
  )
}

export const ConfirmDialog: React.FC<{
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmText?: string
  confirmColor?: string
  children?: React.ReactNode
}> = ({ isOpen, onClose, onConfirm, title, message, confirmText = 'Confirm', confirmColor = 'bg-rose-600 hover:bg-rose-700', children }) => (
  <Modal isOpen={isOpen} onClose={onClose} title={title}>
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="p-2 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-lg shrink-0">
          <AlertCircle size={20} />
        </div>
        <p className="text-sm font-medium text-gray-600 dark:text-slate-300 leading-relaxed">{message}</p>
      </div>
      {children}
      <div className="flex justify-end gap-3 pt-4 border-t border-gray-50 dark:border-slate-800/50">
        <button onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-gray-400 hover:text-gray-900 dark:hover:text-slate-200 transition-colors">
          Cancel
        </button>
        <button
          onClick={() => {
            onConfirm()
            onClose()
          }}
          className={`${confirmColor} text-white px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-widest shadow-sm transition-all`}
        >
          {confirmText}
        </button>
      </div>
    </div>
  </Modal>
)
