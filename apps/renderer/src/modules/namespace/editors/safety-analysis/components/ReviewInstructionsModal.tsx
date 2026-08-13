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
import { Alert, Modal, Space, Spin, Table, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { ProfileReviewCatalogItem } from '@riacore/app-contracts';
import ReactMarkdown from 'react-markdown';
import { useSafetyProfileMetadata } from '../hooks/useSafetyProfileMetadata';

const { Title, Text, Paragraph } = Typography;

interface ReviewInstructionsModalProps {
  open: boolean;
  onClose: () => void;
}

function catalogColumns(items: ProfileReviewCatalogItem[]): ColumnsType<ProfileReviewCatalogItem> {
  const columns: ColumnsType<ProfileReviewCatalogItem> = [
    {
      title: 'Failure Mode',
      dataIndex: 'name',
      key: 'name',
      width: items.some((item) => item.measures) ? '25%' : '30%',
      render: (text: string) => <Text strong style={{ fontSize: 12 }}>{text}</Text>,
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      width: items.some((item) => item.measures) ? '45%' : '70%',
      render: (text: string) => <Text style={{ fontSize: 12 }}>{text}</Text>,
    },
  ];
  if (items.some((item) => item.measures)) {
    columns.push({
      title: 'Potential Measures',
      dataIndex: 'measures',
      key: 'measures',
      width: '30%',
      render: (text?: string) => <Text type="secondary" style={{ fontSize: 12 }}>{text}</Text>,
    });
  }
  return columns;
}

function MarkdownParagraph({ children }: { children: string }) {
  return (
    <ReactMarkdown components={{ p: ({ children: content }) => <Paragraph>{content}</Paragraph> }}>
      {children}
    </ReactMarkdown>
  );
}

export function ReviewInstructionsModal({ open, onClose }: ReviewInstructionsModalProps) {
  const profile = useSafetyProfileMetadata();
  const instructions = profile.review?.instructions;

  return (
    <Modal
      title={
        <Space>
          <InfoCircleOutlined style={{ color: '#1677ff' }} />
          <span>{instructions?.title ?? 'Review Instructions'}</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={960}
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto', padding: '16px 24px' } }}
    >
      {profile.isLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : profile.error ? (
        <Alert type="error" showIcon message="Could not load profile review instructions" description={profile.error.message} />
      ) : !instructions ? (
        <Alert type="warning" showIcon message="This profile does not define review instructions" />
      ) : (
        <Typography>
          {instructions.sections.map((section, sectionIndex) => (
            <div key={section.id}>
              <Title level={4} style={{ marginTop: sectionIndex === 0 ? 0 : 24 }}>
                {section.title}
              </Title>
              {section.paragraphs.map((paragraph, index) => (
                <MarkdownParagraph key={`${section.id}-p-${index}`}>{paragraph}</MarkdownParagraph>
              ))}
              {section.bullets && (
                <ul style={{ paddingLeft: 20, marginBottom: 16 }}>
                  {section.bullets.map((bullet, index) => (
                    <li key={`${section.id}-b-${index}`}><MarkdownParagraph>{bullet}</MarkdownParagraph></li>
                  ))}
                </ul>
              )}
              {section.catalogs?.map((catalogId) => {
                const catalog = instructions.catalogs.find((item) => item.id === catalogId);
                if (!catalog) return null;
                return (
                  <div key={catalog.id}>
                    <Title level={5}>{catalog.title}</Title>
                    <Table<ProfileReviewCatalogItem>
                      dataSource={catalog.items}
                      columns={catalogColumns(catalog.items)}
                      pagination={false}
                      size="small"
                      rowKey="key"
                      style={{ marginBottom: 24 }}
                      scroll={{ x: true }}
                    />
                  </div>
                );
              })}
              {section.note && (
                <Paragraph type="secondary" style={{ fontSize: 12 }}>
                  {section.note}
                </Paragraph>
              )}
            </div>
          ))}
        </Typography>
      )}
    </Modal>
  );
}
