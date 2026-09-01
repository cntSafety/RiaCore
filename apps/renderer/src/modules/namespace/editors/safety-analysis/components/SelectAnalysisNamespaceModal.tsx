/*
 * Copyright (c) Samir Sarkic and Simon Roth
 *
 * This file is part of RiaCore.
 *
 * RiaCore is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */
/**
 * SelectAnalysisNamespaceModal
 *
 * Shown when "Add Malfunction" is invoked from a context that has no fixed
 * analysis scope — the generic model browser (`GenericModelBrowserModal`),
 * reached from an imported namespace's tile rather than from inside an
 * analysis. A malfunction is always authored into an analysis (`safety_task`
 * hosting is namespace-scoped), so the caller must resolve one before
 * `CreateMalfunctionModal` can run. When the imported namespace is connected
 * to more than one analysis, this modal is what lets the user choose which
 * one hosts the new malfunction.
 */
import { Modal, Select, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';

const { Text } = Typography;

export interface AnalysisNamespaceOption {
  name: string;
  metamodel: string;
}

interface SelectAnalysisNamespaceModalProps {
  open: boolean;
  analyses: AnalysisNamespaceOption[];
  /** Display name of the architecture element the malfunction will be attached to. */
  targetName?: string;
  onSelect: (namespace: string) => void;
  onClose: () => void;
}

export function SelectAnalysisNamespaceModal({
  open, analyses, targetName, onSelect, onClose,
}: SelectAnalysisNamespaceModalProps) {
  const { token } = theme.useToken();
  const [selected, setSelected] = useState<string | undefined>(undefined);

  // Re-seed the default selection every time the modal opens for a new target
  // rather than keeping whatever was picked last time.
  useEffect(() => {
    if (open) setSelected(analyses[0]?.name);
  }, [open, analyses]);

  return (
    <Modal
      title="Select Analysis"
      open={open}
      onCancel={onClose}
      onOk={() => { if (selected) onSelect(selected); }}
      okText="Continue"
      okButtonProps={{ disabled: !selected }}
      destroyOnClose
      width={420}
    >
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
        {targetName
          ? <>Malfunctions are authored in an analysis. Choose the analysis that should host the new malfunction on <Text strong style={{ fontSize: 12, color: token.colorText }}>{targetName}</Text>.</>
          : 'Malfunctions are authored in an analysis. Choose the analysis that should host the new malfunction.'}
      </Text>
      <Select
        style={{ width: '100%' }}
        value={selected}
        onChange={setSelected}
        options={analyses.map((a) => ({ value: a.name, label: `${a.name} (${a.metamodel})` }))}
        autoFocus
      />
    </Modal>
  );
}
