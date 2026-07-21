'use client'

import React, { useState, useEffect } from 'react'
import { listWorkflows, createWorkflow, deleteWorkflow } from '@/lib/actions/workflows'
import { Card, Modal, ConfirmDialog } from '@/components/ui'
import type { CinematicWorkflow } from '@/types'
import { Plus, Video, Clock, ArrowRight, Loader2, PlayCircle, Film, Trash2 } from 'lucide-react'

interface Props {
  onSelectWorkflow: (workflowId: string) => void
}

export const WorkflowsList: React.FC<Props> = ({ onSelectWorkflow }) => {
  const [workflows, setWorkflows] = useState<CinematicWorkflow[]>([])
  const [loading, setLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [workflowToDelete, setWorkflowToDelete] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    fetchWorkflows()
  }, [])

  const fetchWorkflows = async () => {
    setLoading(true)
    try {
      setWorkflows(await listWorkflows())
    } catch (err: any) {
      console.error('Failed to load workflows:', err?.message ?? err)
      setWorkflows([])
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    setIsSubmitting(true)
    try {
      await createWorkflow(newTitle)
      setNewTitle('')
      setIsCreating(false)
      fetchWorkflows()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDeleteWorkflow = async () => {
    if (!workflowToDelete) return
    setIsDeleting(true)
    try {
      await deleteWorkflow(workflowToDelete)
      setWorkflows(prev => prev.filter(w => w.id !== workflowToDelete))
    } catch (err: any) {
      alert('Failed to delete workflow: ' + err.message)
    } finally {
      setIsDeleting(false)
      setWorkflowToDelete(null)
    }
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center p-10">
        <Loader2 className="animate-spin text-indigo-500" size={32} />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto w-full animate-in fade-in duration-500">
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="text-3xl font-black text-[#34495E] dark:text-slate-200 uppercase tracking-tighter flex items-center gap-3">
            <Film className="text-indigo-500" size={32} /> Cinematic Workflows
          </h1>
          <p className="text-sm font-bold text-gray-400 mt-2 tracking-widest uppercase">Standalone Video Review Workspaces</p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-black uppercase text-[13px] tracking-widest hover:bg-indigo-700 transition-all shadow-lg hover:shadow-indigo-500/25 flex items-center gap-2 active:scale-95"
        >
          <Plus size={16} /> New Workflow
        </button>
      </div>

      {workflows.length === 0 ? (
        <div className="bg-white dark:bg-slate-800 border border-dashed border-gray-300 dark:border-slate-800 rounded-3xl p-16 text-center shadow-sm">
          <div className="w-20 h-20 bg-indigo-50 dark:bg-slate-700 rounded-full flex items-center justify-center mx-auto mb-6 text-indigo-500">
            <Video size={32} />
          </div>
          <h3 className="text-xl font-black uppercase tracking-tighter text-[#34495E] dark:text-slate-200 mb-2">No Workflows Yet</h3>
          <p className="text-gray-500 font-medium mb-6 max-w-md mx-auto">Create a standalone cinematic workflow to upload videos and collaborate with your team outside of the standard task structure.</p>
          <button onClick={() => setIsCreating(true)} className="bg-indigo-50 dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 px-6 py-3 rounded-xl font-black uppercase text-[13px] tracking-widest hover:brightness-95 transition-all">
            Create First Workflow
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {workflows.map(wf => (
            <Card key={wf.id} className="p-0 overflow-hidden hover:shadow-xl transition-all group cursor-pointer border-transparent hover:border-indigo-100 dark:border-indigo-500/20 dark:hover:border-indigo-900/50" onClick={() => onSelectWorkflow(wf.id)}>
               <div className="h-32 bg-gradient-to-br from-slate-800 to-slate-950 relative overflow-hidden group-hover:scale-105 transition-transform duration-700">
                 <div className="absolute inset-0 flex items-center justify-center">
                    <PlayCircle size={40} className="text-white/20 group-hover:text-indigo-400/80 transition-colors duration-500" strokeWidth={1.5} />
                 </div>
               </div>
               <div className="p-5">
                 <h3 className="text-lg font-black text-[#34495E] dark:text-slate-200 uppercase tracking-tighter mb-2 line-clamp-1">{wf.title}</h3>
                 <div className="flex items-center justify-between text-xs font-bold text-gray-400 uppercase tracking-wider">
                   <span className="flex items-center gap-1.5"><Clock size={12}/> {new Date(wf.created_at).toLocaleDateString('en-GB')}</span>
                   <div className="flex items-center gap-3">
                     <button
                       onClick={(e) => { e.stopPropagation(); setWorkflowToDelete(wf.id); }}
                       className="p-1.5 text-rose-300 hover:text-white hover:bg-rose-50 dark:hover:bg-rose-500/100 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                       title="Delete Workflow"
                     >
                       <Trash2 size={14} />
                     </button>
                     <span className="flex items-center gap-1 text-indigo-500 group-hover:translate-x-1 transition-transform">Open <ArrowRight size={12}/></span>
                   </div>
                 </div>
               </div>
            </Card>
          ))}
        </div>
      )}

      {isCreating && (
        <Modal isOpen={true} onClose={() => setIsCreating(false)} title="New Cinematic Workflow">
          <div className="space-y-6">
            <div>
              <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Workflow Title</label>
              <input
                autoFocus
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                placeholder="e.g. Summer Campaign Review..."
                className="w-full bg-[#f8f9fd] dark:bg-slate-800 border border-gray-200 dark:border-slate-800 rounded-xl px-4 py-3 text-sm font-bold text-[#34495E] dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setIsCreating(false)} className="px-5 py-2.5 rounded-xl font-black uppercase text-xs tracking-widest text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">Cancel</button>
              <button onClick={handleCreate} disabled={!newTitle.trim() || isSubmitting} className="bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-black uppercase text-xs tracking-widest hover:bg-indigo-700 disabled:opacity-50 transition-all shadow-md">
                {isSubmitting ? 'Creating...' : 'Create Workflow'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        isOpen={!!workflowToDelete}
        onClose={() => setWorkflowToDelete(null)}
        onConfirm={handleDeleteWorkflow}
        title="DELETE CINEMATIC WORKFLOW"
        message={`Are you sure you want to permanently delete this workflow? This will erase all videos and feedback nodes within it. This action cannot be undone.`}
        confirmText={isDeleting ? 'DELETING...' : 'DELETE WORKFLOW'}
        confirmColor="bg-rose-600 hover:bg-rose-700"
      />
    </div>
  )
}
