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
import { Modal, Typography } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';

const { Text, Paragraph } = Typography;

interface Props {
  /** The resolved absolute path of the chosen directory. */
  dirPath: string;
  /** Controls whether the dialog is visible. */
  open: boolean;
  /** Called when the user clicks "Create Workspace". */
  onConfirm: () => void;
  /** Called when the user clicks "Cancel", presses Escape, or clicks outside. */
  onCancel: () => void;
}

/**
 * Blocking confirmation dialog shown when the user selects an empty directory
 * via "Open Workspace" and neither a DB nor valid ria-data was found.
 *
 * The user must explicitly confirm before a new workspace is initialised,
 * preventing accidental workspace creation in the wrong folder.
 *
 * Requirements: 13.1–13.7
 */
export function EmptyDirConfirmDialog({ dirPath, open, onConfirm, onCancel }: Props) {
  return (
    <Modal
      title="Create new workspace?"
      open={open}
      onOk={onConfirm}
      onCancel={onCancel}
      okText="Create Workspace"
      cancelText="Cancel"
      okButtonProps={{ type: 'primary' }}
      cancelButtonProps={{ type: 'default' }}
      maskClosable={true}
      keyboard={true}
      closable={true}
      width={480}
      destroyOnClose
      aria-label="Create new workspace confirmation"
    >
      <Paragraph>
        No database and no ria-data folder were found in this directory. Would you like to create a
        new workspace here?
      </Paragraph>
      <Paragraph>
        <Text type="secondary" style={{ fontSize: 12 }}>
          <FolderOpenOutlined style={{ marginRight: 6 }} />
          {dirPath}
        </Text>
      </Paragraph>
    </Modal>
  );
}
