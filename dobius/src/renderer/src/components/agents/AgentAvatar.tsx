import {
  Activity,
  BookOpen,
  Bot,
  Compass,
  Eye,
  Pen,
  Shield,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { AgentIcon } from '../../../../shared/agents'
import { cn } from '@/lib/utils'

const ICONS: Record<AgentIcon, LucideIcon> = {
  compass: Compass,
  shield: Shield,
  activity: Activity,
  pen: Pen,
  bot: Bot,
  eye: Eye,
  wrench: Wrench,
  book: BookOpen
}

export function AgentAvatar({
  icon,
  color,
  className
}: {
  icon: AgentIcon
  color: string
  className?: string
}): React.JSX.Element {
  const Icon = ICONS[icon] ?? Bot
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground',
        className
      )}
      style={{ color }}
    >
      <Icon className="size-4" />
    </span>
  )
}

export { ICONS as AGENT_ICON_COMPONENTS }
