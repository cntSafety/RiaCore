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
 * DiffNamespaceSelector — lets the user pick namespaces and trigger computation.
 * Supports two-way mode (left + right) and three-way mode (base + left + right).
 */

import { Button, Select, Space, Switch, Tooltip, Typography } from 'antd';
import { SwapOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import { useDiffStore } from '../../store/diffStore';
import { useNamespaces } from '../../hooks/useNamespaces';
import { useComputeDiff, useComputeThreeWayDiff } from '../../hooks/useDiffMutations';
import { useWorkspaceState, isDbOpen } from '../../hooks/useWorkspaceState';
import type { NamespaceInfo } from '@riacore/app-contracts';

const { Text } = Typography;

interface Props {
  onBack?: () => void;
}

export function DiffNamespaceSelector({ onBack }: Props) {
  const {
    mode, setMode,
    leftNs, setLeftNs,
    rightNs, setRightNs,
    baseNs, setBaseNs,
    reset,
  } = useDiffStore();

  const wsState = useWorkspaceState();
  const workspaceKey = wsState.phase !== 'no_workspace' ? wsState.workingDir : null;
  const dbOpen = isDbOpen(wsState);
  const { data: namespaces = [] } = useNamespaces(dbOpen, workspaceKey);
  const computeDiff = useComputeDiff();
  const computeThreeWay = useComputeThreeWayDiff();

  const nsOptions = (namespaces as NamespaceInfo[]).map(ns => ({
    label: ns.name,
    value: ns.name,
  }));

  const canCompute = mode === 'two-way'
    ? leftNs && rightNs && leftNs !== rightNs
    : baseNs && leftNs && rightNs && new Set([baseNs, leftNs, rightNs]).size === 3;

  const isLoading = computeDiff.isPending || computeThreeWay.isPending;

  const handleCompute = () => {
    reset();
    if (mode === 'two-way') {
      computeDiff.mutate({ leftNs, rightNs });
    } else {
      computeThreeWay.mutate({ baseNs, leftNs, rightNs });
    }
  };

  const handleSwapMode = (checked: boolean) => {
    setMode(checked ? 'three-way' : 'two-way');
    reset();
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      {onBack && (
        <Button
          icon={<ArrowLeftOutlined />}
          type="text"
          size="small"
          onClick={onBack}
        />
      )}

      <Text strong style={{ fontSize: 14, flexShrink: 0 }}>
        Diff
      </Text>

      {/* Mode toggle */}
      <Space size={4}>
        <Text type="secondary" style={{ fontSize: 12 }}>3-way</Text>
        <Switch
          size="small"
          checked={mode === 'three-way'}
          onChange={handleSwapMode}
        />
      </Space>

      {/* Three-way base selector */}
      {mode === 'three-way' && (
        <Tooltip title="Base namespace (common ancestor)">
          <Select
            size="small"
            style={{ width: 200 }}
            placeholder="Base namespace"
            value={baseNs || undefined}
            onChange={setBaseNs}
            options={nsOptions}
            showSearch
            filterOption={(input, opt) =>
              (opt?.label ?? '').toLowerCase().includes(input.toLowerCase())
            }
          />
        </Tooltip>
      )}

      {/* Left namespace */}
      <Tooltip title={mode === 'three-way' ? 'Left variant' : 'Left namespace'}>
        <Select
          size="small"
          style={{ width: 200 }}
          placeholder={mode === 'three-way' ? 'Left variant' : 'Left namespace'}
          value={leftNs || undefined}
          onChange={setLeftNs}
          options={nsOptions}
          showSearch
          filterOption={(input, opt) =>
            (opt?.label ?? '').toLowerCase().includes(input.toLowerCase())
          }
        />
      </Tooltip>

      <SwapOutlined style={{ color: '#888', flexShrink: 0 }} />

      {/* Right namespace */}
      <Tooltip title={mode === 'three-way' ? 'Right variant' : 'Right namespace'}>
        <Select
          size="small"
          style={{ width: 200 }}
          placeholder={mode === 'three-way' ? 'Right variant' : 'Right namespace'}
          value={rightNs || undefined}
          onChange={setRightNs}
          options={nsOptions}
          showSearch
          filterOption={(input, opt) =>
            (opt?.label ?? '').toLowerCase().includes(input.toLowerCase())
          }
        />
      </Tooltip>

      <Button
        type="primary"
        size="small"
        disabled={!canCompute}
        loading={isLoading}
        onClick={handleCompute}
      >
        Compute Diff
      </Button>

      {(computeDiff.isError || computeThreeWay.isError) && (
        <Text type="danger" style={{ fontSize: 12 }}>
          {(computeDiff.error ?? computeThreeWay.error)?.message ?? 'Computation failed'}
        </Text>
      )}
    </div>
  );
}
