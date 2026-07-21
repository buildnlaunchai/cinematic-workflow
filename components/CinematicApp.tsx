'use client'

import React, { useState } from 'react'
import { getWorkflow } from '@/lib/actions/workspace'
import type { User, CinematicWorkflow } from '@/types'
import { WorkflowsList } from '@/components/WorkflowsList'
import { Workspace } from '@/components/Workspace'
import { Loader2 } from 'lucide-react'

interface Props {
  user: User
}

export const CinematicApp: React.FC<Props> = ({ user }) => {
  const [activeWorkflow, setActiveWorkflow] = useState<CinematicWorkflow | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const handleSelectWorkflow = async (id: string) => {
    setLoadingId(id)
    try {
      setActiveWorkflow(await getWorkflow(id))
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingId(null)
    }
  }

  if (loadingId) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-[#EEF2F3] dark:bg-slate-900">
        <Loader2 className="animate-spin text-[#3A9BDC]" size={32} />
      </div>
    )
  }

  // Standalone app: no ERP shell to escape, so the workspace renders directly as
  // normal JSX. (The source used createPortal(workspace, document.body) to break
  // out of the ERP sidebar/topbar; that portal is intentionally removed here.)
  if (activeWorkflow) {
    return (
      <Workspace
        user={user}
        workflow={activeWorkflow}
        onBackList={() => setActiveWorkflow(null)}
      />
    )
  }

  return <WorkflowsList onSelectWorkflow={handleSelectWorkflow} />
}
