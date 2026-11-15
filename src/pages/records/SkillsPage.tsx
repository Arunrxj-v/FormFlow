import { useEffect, useMemo, useState } from 'react';
import { Award, CheckCircle2, Plus, Sparkles, Tag, Trash2, Wrench } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/context/ToastContext';
import { recordService } from '@/services/recordService';
import { useApp } from '@/context/AppContext';

interface Skill {
  id: string;
  name: string;
  category: 'Technical' | 'Tools' | 'Languages' | 'Certification';
  level: number;
  source: string;
}

const starter: Skill[] = [];

const blank = { name: '', category: 'Technical' as Skill['category'], level: 70 };

export function SkillsPage() {
  const { fields } = useApp();
  const { toast } = useToast();
  const [skills, setSkills] = useState<Skill[]>(starter);
  const [form, setForm] = useState<typeof blank | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);

  useEffect(() => {
    // Check skills from vault fields
    const skillField = fields.find((f) => f.key === 'other.skills');
    const vaultSkills: Skill[] = [];
    if (skillField?.value) {
      const items = skillField.value.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
      items.forEach((item, idx) => {
        vaultSkills.push({
          id: `sk_vault_${idx}`,
          name: item,
          category: 'Technical',
          level: 80,
          source: skillField.source.documentName || 'Vault',
        });
      });
    }

    recordService.listEmployment().then((records) => {
      const names = new Set(records.flatMap((record) => record.skills));
      setSkills((current) => {
        const base = [...vaultSkills, ...current];
        const known = new Set(base.map((skill) => skill.name.toLowerCase()));
        const extra = [...names].filter((name) => !known.has(name.toLowerCase())).map((name, index) => ({
          id: `sk_auto_${index}`,
          name,
          category: 'Technical' as const,
          level: 75,
          source: 'Employment record',
        }));
        return extra.length ? [...base, ...extra] : base;
      });
    });
  }, [fields]);

  const groups = useMemo(() => ['Technical', 'Tools', 'Languages', 'Certification'] as const, []);
  const sourceDocuments = new Set(fields.map((field) => field.source.documentName));

  const add = () => {
    if (!form?.name.trim()) return;
    setSkills((current) => [{ id: `sk_${Date.now()}`, name: form.name.trim(), category: form.category, level: form.level, source: 'Added by you' }, ...current]);
    setForm(null);
    toast({ tone: 'success', title: 'Skill added', message: 'Available for autofill.' });
  };

  return (
    <div>
      <PageHeader
        eyebrow={<>My information <span>›</span> Skills &amp; certifications</>}
        title="Skills & Certifications"
        description="Keywords and credentials FormFlow can match against skills sections and eligibility questions."
        actions={<Button variant="primary" icon={Plus} onClick={() => setForm({ ...blank })}>Add skill</Button>}
      />

      <div className="ff-record-layout">
        <div className="ff-record-stack">
          {skills.length === 0 ? (
            <Card className="ff-section-card" style={{ padding: '40px 24px', textAlign: 'center' }}>
              <div style={{ display: 'inline-flex', padding: 14, borderRadius: '50%', background: 'var(--ff-surface-subtle)', marginBottom: 16 }}>
                <Wrench size={28} className="ff-primary" />
              </div>
              <div className="ff-h3">No saved skills or certificates</div>
              <p className="ff-body-sm ff-muted" style={{ maxWidth: 440, margin: '8px auto 20px', lineHeight: 1.5 }}>
                Skills and certifications will appear here once extracted from your resumes and certificates. You can also add professional skills manually.
              </p>
              <Button variant="primary" icon={Plus} onClick={() => setForm({ ...blank })}>Add skill</Button>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader title="Skill inventory" subtitle={`${skills.length} skills · ${skills.filter((skill) => skill.category === 'Certification').length} certifications`} action={<Badge tone="success">Ready</Badge>} />
                <div style={{ padding: '0 16px 16px' }}>
                  {groups.map((group) => {
                    const groupSkills = skills.filter((skill) => skill.category === group);
                    if (!groupSkills.length) return null;
                    return (
                      <div className="ff-skill-group" key={group}>
                        <div className="ff-row ff-gap-6 ff-mb-8">
                          {group === 'Certification' ? <Award size={14} className="ff-primary" /> : group === 'Languages' ? <Tag size={14} className="ff-primary" /> : <Wrench size={14} className="ff-primary" />}
                          <span className="ff-label">{group}</span>
                          <span className="ff-code ff-muted">{groupSkills.length}</span>
                        </div>
                        <div className="ff-stack ff-gap-6">
                          {groupSkills.map((skill) => (
                            <div className="ff-skill-row" key={skill.id}>
                              <span className="ff-skill-row__name">{skill.name}</span>
                              <div className="ff-skill-row__bar"><span style={{ width: `${skill.level}%` }} /></div>
                              <span className="ff-code ff-muted" style={{ width: 34, textAlign: 'right' }}>{skill.level}%</span>
                              <span className="ff-body-sm ff-muted ff-truncate" style={{ width: 170 }}>{skill.source}</span>
                              <IconButton icon={Trash2} label={`Remove ${skill.name}`} size="sm" onClick={() => setDeleteTarget(skill)} />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>

              {skills.some((skill) => skill.category === 'Certification') ? (
                <Card>
                  <CardHeader title="Certifications" subtitle="Credentials extracted from vault documents" />
                  <div style={{ padding: '0 16px 16px' }}>
                    {skills.filter((skill) => skill.category === 'Certification').map((skill) => (
                      <div className="ff-attachment" key={skill.id} style={{ marginTop: 0, marginBottom: 8 }}>
                        <div className="ff-row ff-gap-8"><span className="ff-record-icon" style={{ width: 32, height: 32 }}><Award size={15} /></span><div><div className="ff-label">{skill.name}</div><div className="ff-body-sm ff-muted">{skill.source}</div></div></div>
                        <Badge tone="success">Verified</Badge>
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}
            </>
          )}
        </div>

        <div className="ff-dashboard-col">
          <Card className="ff-section-card">
            <div className="ff-row ff-gap-8"><Sparkles size={17} className="ff-primary" /><span className="ff-h3">Autofill mapping</span></div>
            <p className="ff-body-sm ff-muted ff-mt-8">The extension matches skills by name and common aliases. It never invents proficiency.</p>
            <div className="ff-stack ff-gap-8 ff-mt-12">
              <div className="ff-info-pair"><span>Technical skills</span><span>{skills.filter((skill) => skill.category === 'Technical').length}</span></div>
              <div className="ff-info-pair"><span>Tools</span><span>{skills.filter((skill) => skill.category === 'Tools').length}</span></div>
              <div className="ff-info-pair"><span>Languages</span><span>{skills.filter((skill) => skill.category === 'Languages').length}</span></div>
              <div className="ff-info-pair"><span>Certifications</span><span>{skills.filter((skill) => skill.category === 'Certification').length}</span></div>
            </div>
          </Card>
          <Card className="ff-section-card">
            <div className="ff-row ff-gap-8"><CheckCircle2 size={17} style={{ color: 'var(--ff-success)' }} /><span className="ff-h3">Source coverage</span></div>
            <p className="ff-body-sm ff-muted ff-mt-8">{sourceDocuments.size} vault documents contribute to this profile.</p>
            <div className="ff-note ff-mt-12">Skills added manually are labeled “Added by you” so you can always tell them apart from extracted values.</div>
          </Card>
        </div>
      </div>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title="Add a skill"
        description="Skills saved to your personal vault."
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" onClick={add} disabled={!form?.name.trim()}>Add skill</Button></>}
      >
        {form ? (
          <div className="ff-stack ff-gap-12">
            <Input label="Skill name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Figma" autoFocus />
            <div className="ff-field">
              <label className="ff-field__label" htmlFor="skill-category">Category</label>
              <select id="skill-category" className="ff-select" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as Skill['category'] })}>
                <option>Technical</option><option>Tools</option><option>Languages</option><option>Certification</option>
              </select>
            </div>
            <div className="ff-field">
              <label className="ff-field__label" htmlFor="skill-level">Confidence / proficiency · {form.level}%</label>
              <input id="skill-level" type="range" min={20} max={100} value={form.level} onChange={(event) => setForm({ ...form, level: Number(event.target.value) })} />
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove this skill?"
        description="This removes the skill from your profile. Source documents remain unchanged."
        confirmLabel="Remove skill"
        destructive
        onConfirm={() => {
          if (deleteTarget) setSkills((current) => current.filter((skill) => skill.id !== deleteTarget.id));
          setDeleteTarget(null);
          toast({ tone: 'success', title: 'Skill removed' });
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
