import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Layout,
  message,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from 'antd';
import { ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import { Pie } from '@antv/g2plot';
import { BankConfig, ParsedModel, SwapRecord } from './types';
import {
  BASELINE_MODEL_ID,
  FALLBACK_CONFIG,
  buildStorageKey,
  getEmbeddedCodeFromLocation,
  getInitialBalanceFromConfig,
  parseConfigFromSuffix
} from './lib/configParser';

const { Content, Header } = Layout;
const { Title, Text, Paragraph } = Typography;

type PersistedState = {
  balances: Record<string, number>;
  records: SwapRecord[];
  savedAt: number;
};

const round6 = (value: number): number => Number(value.toFixed(6));

const getModelRate = (models: ParsedModel[], modelId: string): number => {
  return models.find((item) => item.id === modelId)?.rate ?? 1;
};

const sumByBaseline = (balances: Record<string, number>, models: ParsedModel[]): number => {
  return round6(
    Object.entries(balances).reduce((acc, [id, amount]) => {
      const rate = getModelRate(models, id);
      return acc + amount * rate;
    }, 0),
  );
};

const alignModelRows = (balances: Record<string, number>, models: ParsedModel[]) => {
  const result: Record<string, number> = {};
  models.forEach((item) => {
    result[item.id] = Number.isFinite(balances[item.id]) ? balances[item.id] : 0;
  });
  return result;
};

const App: React.FC = () => {
  const [config, setConfig] = useState<BankConfig>(FALLBACK_CONFIG);
  const [balances, setBalances] = useState<Record<string, number>>(
    getInitialBalanceFromConfig(FALLBACK_CONFIG),
  );
  const [records, setRecords] = useState<SwapRecord[]>([]);
  const [rawConfigText, setRawConfigText] = useState('');
  const [messageApi, contextHolder] = message.useMessage();
  const pieRef = useRef<HTMLDivElement | null>(null);
  const [form] = Form.useForm();

  const modelOptions = useMemo(
    () =>
      config.models.map((item) => ({
        label: `${item.id} (x ${item.rate})`,
        value: item.id
      })),
    [config.models],
  );

  const totalInBaseline = useMemo(
    () => sumByBaseline(balances, config.models),
    [balances, config.models],
  );

  const saveState = (next: BankConfig, nextBalances: Record<string, number>, nextRecords: SwapRecord[]) => {
    try {
      const key = buildStorageKey(next);
      const payload: PersistedState = {
        balances: nextBalances,
        records: nextRecords,
        savedAt: Date.now()
      };
      localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      // 忽略本地存储异常（某些浏览环境会受限）
    }
  };

  const normalizeAndApplyConfig = (nextConfig: BankConfig) => {
    const modelAwareBalances = alignModelRows(
      nextConfig.initialBalances
        ? {
            ...getInitialBalanceFromConfig(nextConfig),
            ...nextConfig.initialBalances
          }
        : getInitialBalanceFromConfig(nextConfig),
      nextConfig.models,
    );

    const storageKey = buildStorageKey(nextConfig);
    let restoredBalances = modelAwareBalances;
    let restoredRecords: SwapRecord[] = [];

    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed?.balances || parsed?.records) {
          if (parsed.balances) {
            const merged: Record<string, number> = alignModelRows(parsed.balances, nextConfig.models);
            const hasSome = Object.values(merged).some((value) => value > 0);
            if (hasSome) {
              restoredBalances = merged;
            }
          }

          if (Array.isArray(parsed.records)) {
            restoredRecords = parsed.records
              .filter(
                (item): item is SwapRecord =>
                  Boolean(item && item.from && item.to && Number.isFinite(item.at)),
              )
              .sort((a, b) => b.at - a.at);
          }
        }
      }
    } catch {
      // 忽略存储损坏
    }

    setConfig(nextConfig);
    setBalances(alignModelRows(restoredBalances, nextConfig.models));
    setRecords(restoredRecords.slice(0, 50));
    form.setFieldsValue({
      from: nextConfig.models[0]?.id,
      to: nextConfig.models[1]?.id || nextConfig.models[0]?.id,
      amount: undefined
    });
    messageApi.success(`已加载配置：${nextConfig.profileName}`);
  };

  const readConfigFromLocation = () => {
    const code = getEmbeddedCodeFromLocation();
    if (!code) return;
    const parsed = parseConfigFromSuffix(code);
    if (!parsed) {
      messageApi.error('读取到的配置无法解析，请检查网址后缀格式');
      return;
    }
    normalizeAndApplyConfig(parsed);
  };

  useEffect(() => {
    readConfigFromLocation();

    const onLocationChange = () => {
      const code = getEmbeddedCodeFromLocation();
      if (code) {
        const parsed = parseConfigFromSuffix(code);
        if (parsed) {
          normalizeAndApplyConfig(parsed);
        }
      }
    };

    window.addEventListener('hashchange', onLocationChange);
    window.addEventListener('popstate', onLocationChange);

    return () => {
      window.removeEventListener('hashchange', onLocationChange);
      window.removeEventListener('popstate', onLocationChange);
    };
  }, []);

  useEffect(() => {
    saveState(config, balances, records);
  }, [config, balances, records]);

  useEffect(() => {
    if (!pieRef.current) return;
    const data = Object.entries(balances)
      .map(([name, value]) => ({
        name,
        value
      }))
      .filter((item) => item.value > 0);

    if (!data.length) {
      pieRef.current.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8c8f96;font-size:14px;">暂无可显示的正向余额</div>';
      return;
    }

    const plot = new Pie(pieRef.current, {
      data,
      angleField: 'value',
      colorField: 'name',
      radius: 0.8,
      tooltip: {
        showTitle: false,
        fields: ['name', 'value'],
        formatter: (datum: { name: string; value: number }) => {
          const rate = getModelRate(config.models, datum.name);
          return {
            name: datum.name,
            value: `${round6(datum.value)} token`,
            customInfo: `折算基准值：${round6(datum.value * rate)} (${BASELINE_MODEL_ID})`
          };
        }
      },
      label: {
        type: 'spider',
        content: '{name} {value}'
      },
      state: {
        active: { style: { stroke: '#000', lineWidth: 2 } }
      },
      interactions: [{ type: 'element-active' }],
      legend: {
        position: 'bottom'
      }
    });

    plot.render();

    return () => {
      plot.destroy();
    };
  }, [balances, config.models]);

  const onSwap = async () => {
    try {
      const values = await form.validateFields();
      const from = values.from as string;
      const to = values.to as string;
      const rawAmount = Number(values.amount);
      if (!from || !to || from === to) {
        messageApi.error('请选择不同的来源和目标模型');
        return;
      }
      if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
        messageApi.error('请输入大于 0 的兑换数量');
        return;
      }

      const sourceAmount = balances[from] ?? 0;
      if (sourceAmount < rawAmount) {
        messageApi.error('来源余额不足');
        return;
      }

      const fromRate = getModelRate(config.models, from);
      const toRate = getModelRate(config.models, to);
      const toAmount = round6((rawAmount * fromRate) / Math.max(0.000001, toRate));

      setBalances((prev) => {
        const next = {
          ...prev,
          [from]: round6(Math.max(0, prev[from] - rawAmount)),
          [to]: round6((prev[to] ?? 0) + toAmount)
        };
        return alignModelRows(next, config.models);
      });

      setRecords((prev) => {
        const record: SwapRecord = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          from,
          to,
          fromAmount: rawAmount,
          toAmount,
          at: Date.now()
        };
        return [record, ...prev].slice(0, 50);
      });

      form.setFieldValue('amount', undefined);
      messageApi.success('兑换成功');
    } catch {
      // 表单错误走校验提示
    }
  };

  const onManualParse = () => {
    const parsed = parseConfigFromSuffix(rawConfigText);
    if (!parsed) {
      messageApi.error('手动输入内容不合法，支持 JSON/base64/json5.5 或短串格式');
      return;
    }
    normalizeAndApplyConfig(parsed);
  };

  const modelBalanceColumns = [
    {
      title: '模型',
      dataIndex: 'model',
      key: 'model'
    },
    {
      title: '当前余额',
      dataIndex: 'amount',
      key: 'amount',
      render: (value: number) => `${round6(value)} token`
    },
    {
      title: '结算倍率',
      dataIndex: 'rate',
      key: 'rate',
      render: (value: number) => `× ${value}`
    },
    {
      title: '折算基准值',
      dataIndex: 'baseline',
      key: 'baseline',
      render: (_: unknown, row: { amount: number; rate: number }) =>
        `${round6((row.amount || 0) * (row.rate || 1))} token`
    }
  ];

  const modelBalanceRows = config.models.map((item) => ({
    key: item.id,
    model: item.id,
    amount: balances[item.id] ?? 0,
    rate: item.rate,
    baseline: round6((balances[item.id] ?? 0) * item.rate)
  }));

  const recordColumns = [
    {
      title: '时间',
      dataIndex: 'at',
      key: 'at',
      render: (value: number) => new Date(value).toLocaleString()
    },
    {
      title: '来源模型',
      dataIndex: 'from',
      key: 'from',
      render: (value: string) => <Tag color="blue">{value}</Tag>
    },
    {
      title: '目标模型',
      dataIndex: 'to',
      key: 'to',
      render: (value: string) => <Tag color="green">{value}</Tag>
    },
    {
      title: '数量',
      dataIndex: 'fromAmount',
      key: 'fromAmount',
      render: (_: number, record: SwapRecord) =>
        `${round6(record.fromAmount)} -> ${round6(record.toAmount)}`
    }
  ];

  return (
    <Layout className="token-app">
      {contextHolder}
      <Header className="token-header">
        <Title level={3}>tokenSwap 结算中心</Title>
      </Header>
      <Content className="token-content">
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={16}>
            <Card className="token-card" title="配置与链接加载">
              <Alert
                message="URL 自动解析"
                description={`当前网址后缀为：${window.location.href}`}
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
              />
              <Paragraph>
                <Text strong>解析到的钱包：</Text> {config.profileName}
              </Paragraph>
              <Paragraph>
                <Text strong>API Key：</Text> {config.apiKey ? `${config.apiKey.slice(0, 4)}****${config.apiKey.slice(-4)}` : '-'}
              </Paragraph>
              <Paragraph>
                <Text strong>base URL：</Text> {config.baseUrl}
              </Paragraph>
              <Paragraph>
                <Text strong>支持模型：</Text>
                {config.models.map((item) => (
                  <Tag key={item.id} color="purple" style={{ marginBottom: 4 }}>
                    {item.id}
                  </Tag>
                ))}
              </Paragraph>
              <Divider />
              <Space direction="vertical" style={{ width: '100%' }}>
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  placeholder="可手动粘贴配置串（url附加参数、base64(json)或 apiKey|baseUrl|模型:倍率...）"
                  value={rawConfigText}
                  onChange={(event) => setRawConfigText(event.target.value)}
                />
                <Space>
                  <Button onClick={onManualParse} type="primary">
                    解析配置字符串
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={readConfigFromLocation}>
                    重刷当前链接配置
                  </Button>
                </Space>
              </Space>
            </Card>

            <Card className="token-card" title="token 银行兑换" style={{ marginTop: 16 }}>
              <Alert
                message="兑换逻辑（基于基准模型）"
                description={`1 ${BASELINE_MODEL_ID} = 1 基准单位。当前基准总值：${totalInBaseline} token`}
                type="success"
                showIcon
                style={{ marginBottom: 16 }}
              />
              <Form layout="vertical" form={form} onFinish={onSwap}>
                <Row gutter={12}>
                  <Col xs={24} sm={8}>
                    <Form.Item
                      label="来源模型"
                      name="from"
                      rules={[{ required: true, message: '请选择来源模型' }]}
                      initialValue={config.models[0]?.id}
                    >
                      <Select options={modelOptions} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={8}>
                    <Form.Item
                      label="目标模型"
                      name="to"
                      rules={[{ required: true, message: '请选择目标模型' }]}
                      initialValue={config.models[1]?.id || config.models[0]?.id}
                    >
                      <Select options={modelOptions} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={8}>
                    <Form.Item
                      label="兑换数量"
                      name="amount"
                      rules={[{ required: true, message: '请输入数量' }]}
                    >
                      <InputNumber
                        style={{ width: '100%' }}
                        min={0}
                        precision={6}
                        placeholder="输入 token 数量"
                      />
                    </Form.Item>
                  </Col>
                </Row>
                <Button type="primary" icon={<SwapOutlined />} htmlType="submit">
                  执行兑换
                </Button>
              </Form>
            </Card>

            <Card className="token-card" title="兑换记录" style={{ marginTop: 16 }}>
              <Table
                rowKey="id"
                dataSource={records}
                columns={recordColumns}
                size="small"
                pagination={{ pageSize: 5 }}
              />
            </Card>
          </Col>

          <Col xs={24} lg={8}>
            <Card className="token-card" title="余额与占比">
              <div className="token-metric">
                <Text>当前钱包总余额（基准模型视角）</Text>
                <Title level={3} style={{ margin: 0 }}>
                  {totalInBaseline} token
                </Title>
              </div>
              <div ref={pieRef} className="token-chart" />
            </Card>
            <Card className="token-card" title="模型余额明细" style={{ marginTop: 16 }}>
              <Table
                rowKey="key"
                dataSource={modelBalanceRows}
                columns={modelBalanceColumns}
                size="small"
                pagination={false}
              />
            </Card>
          </Col>
        </Row>
      </Content>
    </Layout>
  );
};

export default App;
