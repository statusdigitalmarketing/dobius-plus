import { Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { cn } from '@/lib/utils'

function skillLabel(skill: Pick<DiscoveredSkill, 'name' | 'id'>): string {
  return skill.name || skill.id
}

export function AgentSkillsPicker({
  cwd,
  selected,
  onChange
}: {
  cwd: string
  selected: string[]
  onChange: (skills: string[]) => void
}): React.JSX.Element {
  const [skills, setSkills] = useState<DiscoveredSkill[]>([])
  const [loading, setLoading] = useState(false)
  const selectedSet = useMemo(() => new Set(selected), [selected])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.skills
      .discover({ cwd: cwd || null })
      .then((result) => {
        if (!cancelled) {
          setSkills(result.skills.filter((skill) => skill.installed))
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('Failed to discover agent skills:', error)
          toast.error('Could not load skills')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const toggleSkill = (skill: string): void => {
    const next = new Set(selectedSet)
    if (next.has(skill)) {
      next.delete(skill)
    } else {
      next.add(skill)
    }
    onChange([...next])
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((skill) => (
            <Badge key={skill} variant="outline" className="gap-1">
              <Zap className="size-3 text-[color:var(--annotation-highlight)]" />
              {skill}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {skills.map((skill) => {
          const label = skillLabel(skill)
          const checked = selectedSet.has(label)
          return (
            <Button
              key={skill.id}
              type="button"
              variant={checked ? 'secondary' : 'outline'}
              size="sm"
              className={cn('justify-start', checked && 'ring-1 ring-ring')}
              onClick={() => toggleSkill(label)}
            >
              <Zap className="size-3.5 text-[color:var(--annotation-highlight)]" />
              <span className="truncate">{label}</span>
            </Button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {loading ? 'Loading skills...' : skills.length === 0 ? 'No installed skills found.' : null}
      </p>
    </div>
  )
}
