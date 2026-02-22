import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../store/store';

export default function ClaudeMdEditor() {
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const dashboardTab = useStore((s) => s.dashboardTab);

  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState(''); // '' | 'saving' | 'saved' | 'error'
  const textareaRef = useRef(null);

  const isDirty = content !== savedContent;

  // Load file list
  useEffect(() => {
    if (!window.electronAPI?.fileListClaudeMd) return;
    window.electronAPI.fileListClaudeMd(currentProjectPath).then((list) => {
      setFiles(list || []);
      // Auto-select first existing file, or first file if none exist
      const firstExisting = list?.find((f) => f.exists);
      setSelectedFile(firstExisting || list?.[0] || null);
      setLoading(false);
    });
  }, [currentProjectPath]);

  // Load file content when selection changes
  useEffect(() => {
    if (!selectedFile || !window.electronAPI?.fileRead) {
      setContent('');
      setSavedContent('');
      return;
    }
    if (!selectedFile.exists) {
      setContent('');
      setSavedContent('');
      return;
    }
    window.electronAPI.fileRead(selectedFile.path).then((result) => {
      if (result?.content != null) {
        setContent(result.content);
        setSavedContent(result.content);
      } else {
        setContent('');
        setSavedContent('');
      }
    });
  }, [selectedFile]);

  const handleSave = useCallback(async () => {
    if (!selectedFile || !window.electronAPI?.fileWrite) return;
    setSaveStatus('saving');
    const result = await window.electronAPI.fileWrite(selectedFile.path, content);
    if (result?.ok) {
      setSavedContent(content);
      setSaveStatus('saved');
      // Update file list (file may now exist)
      if (!selectedFile.exists) {
        setFiles((prev) => prev.map((f) => f.path === selectedFile.path ? { ...f, exists: true } : f));
        setSelectedFile((prev) => ({ ...prev, exists: true }));
      }
      setTimeout(() => setSaveStatus(''), 2000);
    } else {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(''), 3000);
    }
  }, [selectedFile, content]);

  // Cmd+S shortcut — only active when CLAUDE.md tab is showing
  useEffect(() => {
    if (dashboardTab !== 'claudemd') return;
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dashboardTab, handleSave]);

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-16 rounded animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
        ))}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-3">
          {/* File selector */}
          {files.map((f) => {
            const isSelected = selectedFile?.path === f.path;
            const label = f.path.includes('.claude/CLAUDE.md')
              ? (f.path.includes(currentProjectPath || '__none__') ? '.claude/CLAUDE.md' : '~/.claude/CLAUDE.md')
              : 'CLAUDE.md';
            return (
              <button
                key={f.path}
                onClick={() => setSelectedFile(f)}
                className="relative px-2.5 py-1.5 text-xs"
                style={{
                  color: isSelected ? 'var(--fg)' : 'var(--dim)',
                  fontWeight: isSelected ? 500 : 400,
                  fontFamily: "'SF Mono', monospace",
                  fontSize: 11,
                  backgroundColor: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  opacity: f.exists ? 1 : 0.5,
                }}
              >
                {label}
                {!f.exists && ' (new)'}
                {isSelected && (
                  <span
                    className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 rounded-full"
                    style={{ width: '80%', backgroundColor: 'var(--accent)' }}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="text-xs" style={{ color: 'var(--accent)', fontSize: 10 }}>
              Unsaved changes
            </span>
          )}
          {saveStatus === 'saved' && (
            <span className="text-xs" style={{ color: 'var(--accent)', fontSize: 10 }}>Saved</span>
          )}
          {saveStatus === 'error' && (
            <span className="text-xs" style={{ color: '#F85149', fontSize: 10 }}>Save failed</span>
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty && selectedFile?.exists}
            style={{
              padding: '4px 12px',
              fontSize: 10,
              fontFamily: "'SF Mono', monospace",
              color: (isDirty || !selectedFile?.exists) ? 'var(--bg)' : 'var(--dim)',
              backgroundColor: (isDirty || !selectedFile?.exists) ? 'var(--accent)' : 'var(--surface)',
              border: 'none',
              borderRadius: 4,
              cursor: (isDirty || !selectedFile?.exists) ? 'pointer' : 'default',
            }}
          >
            {saveStatus === 'saving' ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Split editor + preview */}
      <div className="flex-1 flex min-h-0">
        {/* Editor */}
        <div className="flex-1 flex flex-col min-w-0" style={{ borderRight: '1px solid var(--border)' }}>
          <div
            className="px-3 py-1.5 text-xs shrink-0"
            style={{ color: 'var(--dim)', fontSize: 9, borderBottom: '1px solid var(--border)', fontFamily: "'SF Mono', monospace" }}
          >
            EDITOR
          </div>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            style={{
              flex: 1,
              backgroundColor: 'var(--bg)',
              color: 'var(--fg)',
              border: 'none',
              outline: 'none',
              padding: '12px 16px',
              fontFamily: "'SF Mono', 'Fira Code', monospace",
              fontSize: 12,
              lineHeight: 1.6,
              resize: 'none',
              tabSize: 2,
            }}
          />
        </div>

        {/* Preview */}
        <div className="flex-1 flex flex-col min-w-0">
          <div
            className="px-3 py-1.5 text-xs shrink-0"
            style={{ color: 'var(--dim)', fontSize: 9, borderBottom: '1px solid var(--border)', fontFamily: "'SF Mono', monospace" }}
          >
            PREVIEW
          </div>
          <div
            className="flex-1 overflow-y-auto"
            style={{ padding: '12px 16px', backgroundColor: 'var(--bg)' }}
          >
            <div className="claude-md-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {content || '*Empty file — start typing in the editor*'}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      </div>

      {/* Inline styles for markdown preview */}
      <style>{`
        .claude-md-preview {
          color: var(--fg);
          font-size: 13px;
          line-height: 1.7;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        }
        .claude-md-preview h1 {
          font-size: 1.5em;
          font-weight: 700;
          margin: 1.2em 0 0.5em;
          padding-bottom: 0.3em;
          border-bottom: 1px solid var(--border);
          color: var(--fg);
        }
        .claude-md-preview h2 {
          font-size: 1.25em;
          font-weight: 600;
          margin: 1em 0 0.4em;
          padding-bottom: 0.2em;
          border-bottom: 1px solid var(--border);
          color: var(--fg);
        }
        .claude-md-preview h3 {
          font-size: 1.1em;
          font-weight: 600;
          margin: 0.8em 0 0.3em;
          color: var(--fg);
        }
        .claude-md-preview h4, .claude-md-preview h5, .claude-md-preview h6 {
          font-size: 1em;
          font-weight: 600;
          margin: 0.6em 0 0.2em;
          color: var(--dim);
        }
        .claude-md-preview p {
          margin: 0.5em 0;
        }
        .claude-md-preview ul, .claude-md-preview ol {
          padding-left: 1.5em;
          margin: 0.4em 0;
        }
        .claude-md-preview li {
          margin: 0.2em 0;
        }
        .claude-md-preview code {
          font-family: 'SF Mono', 'Fira Code', monospace;
          font-size: 0.9em;
          background-color: var(--surface);
          padding: 2px 5px;
          border-radius: 3px;
          color: var(--accent);
        }
        .claude-md-preview pre {
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 12px 16px;
          overflow-x: auto;
          margin: 0.6em 0;
        }
        .claude-md-preview pre code {
          background: none;
          padding: 0;
          color: var(--fg);
          font-size: 12px;
        }
        .claude-md-preview blockquote {
          border-left: 3px solid var(--accent);
          padding-left: 12px;
          margin: 0.5em 0;
          color: var(--dim);
        }
        .claude-md-preview table {
          border-collapse: collapse;
          width: 100%;
          margin: 0.6em 0;
          font-size: 12px;
        }
        .claude-md-preview th, .claude-md-preview td {
          border: 1px solid var(--border);
          padding: 6px 10px;
          text-align: left;
        }
        .claude-md-preview th {
          background-color: var(--surface);
          font-weight: 600;
        }
        .claude-md-preview hr {
          border: none;
          border-top: 1px solid var(--border);
          margin: 1em 0;
        }
        .claude-md-preview a {
          color: var(--accent);
          text-decoration: none;
        }
        .claude-md-preview a:hover {
          text-decoration: underline;
        }
        .claude-md-preview strong {
          font-weight: 600;
          color: var(--fg);
        }
        .claude-md-preview img {
          max-width: 100%;
          border-radius: 4px;
        }
      `}</style>
    </div>
  );
}

const markdownComponents = {
  h1: ({ children, ...props }) => <h1 {...props}>{children}</h1>,
  h2: ({ children, ...props }) => <h2 {...props}>{children}</h2>,
  h3: ({ children, ...props }) => <h3 {...props}>{children}</h3>,
  code: ({ inline, className, children, ...props }) => {
    if (inline) {
      return <code {...props}>{children}</code>;
    }
    return <code className={className} {...props}>{children}</code>;
  },
};
