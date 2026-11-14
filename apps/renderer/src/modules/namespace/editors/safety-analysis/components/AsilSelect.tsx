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
import { Select, type SelectProps } from 'antd';
import { ASIL_UNSET_LABEL, ASIL_UNSET_VALUE, useAsilOptionGroups } from '../config/asilColors';
import { useSafetyProfileMetadata } from '../hooks/useSafetyProfileMetadata';
import { AsilTag } from './AsilTag';

export interface AsilSelectProps extends Omit<SelectProps<string>,
  'options' | 'mode' | 'labelInValue' | 'value' | 'defaultValue' | 'onChange' |
  'allowClear' | 'optionRender' | 'labelRender' | 'placeholder'> {
  value?: string | null;
  onChange?: (value: string) => void;
  /** Filters use "All ASIL"; authoring always uses the default "Not set". */
  emptyLabel?: string;
}

/** One profile-backed ASIL editor for dialogs, forms and table cells. */
export function AsilSelect({ value, onChange, emptyLabel = ASIL_UNSET_LABEL, loading, disabled, ...props }: AsilSelectProps) {
  const profile = useSafetyProfileMetadata();
  const groups = useAsilOptionGroups(profile.asilGroups);
  const renderValue = (asil: string) => asil
    ? <AsilTag asil={asil} fontSize={11} />
    : <span>{emptyLabel}</span>;

  return (
    <Select<string>
      aria-label={props.id ? undefined : 'ASIL'}
      popupMatchSelectWidth={240}
      {...props}
      value={value ?? ASIL_UNSET_VALUE}
      onChange={(next) => onChange?.(next ?? ASIL_UNSET_VALUE)}
      allowClear={Boolean(value)}
      loading={loading || profile.isLoading}
      disabled={disabled || Boolean(profile.error)}
      options={[{ label: emptyLabel, value: ASIL_UNSET_VALUE }, ...groups.slice(1)]}
      optionFilterProp="label"
      optionRender={(option) => renderValue(String(option.value ?? ''))}
      labelRender={(option) => renderValue(String(option.value ?? ''))}
    />
  );
}
