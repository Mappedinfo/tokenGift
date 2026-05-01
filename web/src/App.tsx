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
  Steps,
  Table,
  Tabs,
  Tag,
  Typography
} from 'antd';
import {
  CopyOutlined,
  GiftOutlined,
  LockOutlined,
  ReloadOutlined,
  SwapOutlined,
  UploadOutlined
} from '@ant-design/icons';
import { Pie } from '@antv/g2plot';
import { BankConfig, ParsedModel, SwapRecord } from './types';
import {
  BASELINE_MODEL_ID,
  FALLBACK_CONFIG,
  buildConfigShareCode,
  buildStorageKey,
  extractPayloadFromInput,
  getEmbeddedCodeFromLocation,
  getInitialBalanceFromConfig,
  parseConfigFromSuffix
} from './lib/configParser';
import { decryptPayloadWithPrivateKey, encryptConfigForPublicKey } from './lib/tokengiftCrypto';

const { Content, Header } = Layout;
const { Title, Text, Paragraph } = Typography;

type PersistedState = {
  balances: Record<string, number>;
  records: SwapRecord[];
  savedAt: number;
};

type WorkMode = 'swap' | 'gift' | 'claim';

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
  const [activeMode, setActiveMode] = useState<WorkMode>('swap');

  const [recipientPublicKey, setRecipientPublicKey] = useState('');
  const [sendConfigText, setSendConfigText] = useState('');
  const [giftCipherText, setGiftCipherText] = useState('');
  const [giftShareLink, setGiftShareLink] = useState('');
  const [isEncrypting, setIsEncrypting] = useState(false);

  const [recipientPrivateKey, setRecipientPrivateKey] = useState('');
  const [claimPayloadText, setClaimPayloadText] = useState('');
  const [isDecrypting, setIsDecrypting] = useState(false);

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

  const shareableConfigCode = useMemo(() => buildConfigShareCode(config, 'auto'), [config]);

  const buildInviteLink = (cipherText: string): string => {
    const next = new URL(window.location.href);
    ['cfg', 'config', 'tokenCfg', 'token_cfg'].forEach((key) => next.searchParams.delete(key));
    next.searchParams.set('gift', cipherText);
    next.search = next.searchParams.toString();
    next.hash = '';
    return next.toString();
  };

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

  const detectAndApplyFromLocation = () => {
    const code = getEmbeddedCodeFromLocation();
    if (!code) return;

    const parsed = parseConfigFromSuffix(code);
    if (parsed) {
      normalizeAndApplyConfig(parsed);
      setActiveMode('swap');
      return;
    }

    const payload = extractPayloadFromInput(code);
    if (payload) {
      setClaimPayloadText(payload);
      setActiveMode('claim');
      messageApi.info('检测到邀请链接，已自动进入领取模式');
    }
  };

  useEffect(() => {
    setSendConfigText(shareableConfigCode);
  }, [shareableConfigCode]);

  useEffect(() => {
    detectAndApplyFromLocation();

    const onLocationChange = () => {
      detectAndApplyFromLocation();
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

  const copyText = async (value: string, okMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      messageApi.success(okMessage);
    } catch {
      messageApi.error('复制失败，请手动选择文本复制');
    }
  };

  const onCreateGift = async () => {
    const sourceText = sendConfigText.trim() || shareableConfigCode;
    if (!sourceText) {
      messageApi.error('请先填写可加密的配置文本');
      return;
    }

    if (!recipientPublicKey.trim()) {
      messageApi.error('请粘贴接收方的 RSA 公钥');
      return;
    }

    const parsed = parseConfigFromSuffix(sourceText);
    if (!parsed) {
      messageApi.error('配置内容无法解析为有效配置');
      return;
    }

    const normalizedSource = buildConfigShareCode(parsed, 'compact');

    setIsEncrypting(true);
    try {
      const cipher = await encryptConfigForPublicKey(recipientPublicKey, normalizedSource);
      const link = buildInviteLink(cipher);
      setGiftCipherText(cipher);
      setGiftShareLink(link);
      setActiveMode('gift');
      messageApi.success('邀请链接已生成，可复制后发送给对方');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      messageApi.error(msg);
    } finally {
      setIsEncrypting(false);
    }
  };

  const onResetGiftDraft = () => {
    setSendConfigText(shareableConfigCode);
    setGiftCipherText('');
    setGiftShareLink('');
  };

  const openGiftWithPayload = async (payload: string) => {
    if (!payload) {
      messageApi.error('请输入有效的邀请密文或邀请链接');
      return;
    }

    if (!recipientPrivateKey.trim()) {
      messageApi.error('请粘贴 RSA 私钥');
      return;
    }

    setIsDecrypting(true);
    try {
      const plain = await decryptPayloadWithPrivateKey(recipientPrivateKey, payload);
      const parsed = parseConfigFromSuffix(plain);
      if (!parsed) {
        messageApi.error('解密成功，但配置内容无法解析');
        return;
      }

      normalizeAndApplyConfig(parsed);
      setActiveMode('swap');
      setClaimPayloadText('');
      setRecipientPrivateKey('');
      messageApi.success('配置已领取成功，已返回兑换中心');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      messageApi.error(msg);
    } finally {
      setIsDecrypting(false);
    }
  };

  const onQuickOpen = () => {
    const payload = extractPayloadFromInput(claimPayloadText);
    if (!payload) {
      messageApi.error('未检测到可识别的邀请密文');
      return;
    }

    void openGiftWithPayload(payload);
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

  const renderSwapPanel = () => (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card className="token-card token-glass-card" title="配置与链接加载">
            <Alert
              message="URL 自动解析"
              description={`当前网址后缀为：${window.location.href}`}
              type="info"
              showIcon
              className="token-alert"
            />
            <Divider />
            <Paragraph>
              <Text strong>配置摘要：</Text> {config.profileName}
            </Paragraph>
            <Paragraph>
              <Text strong>可分享代码：</Text>
              <Text code className="mono-block">
                {shareableConfigCode}
              </Text>
            </Paragraph>
            <Space wrap style={{ marginBottom: 12 }}>
              <Button
                icon={<CopyOutlined />}
                onClick={() => copyText(shareableConfigCode, '配置摘要已复制')}
              >
                复制配置摘要
              </Button>
              <Button
                icon={<UploadOutlined />}
                onClick={() => setSendConfigText(shareableConfigCode)}
                type="dashed"
              >
                用当前配置填充发起邀请
              </Button>
            </Space>
            <Divider />
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input.TextArea
                autoSize={{ minRows: 2, maxRows: 5 }}
                placeholder="可手动粘贴配置串（url参数、base64(json)、短串格式）"
                value={rawConfigText}
                onChange={(event) => setRawConfigText(event.target.value)}
              />
              <Space>
                <Button onClick={onManualParse} type="primary">
                  解析配置字符串
                </Button>
                <Button icon={<ReloadOutlined />} onClick={detectAndApplyFromLocation}>
                  重刷当前链接
                </Button>
                <Button onClick={() => setRawConfigText('')}>
                  清空输入
                </Button>
              </Space>
            </Space>
          </Card>

          <Card className="token-card token-glass-card" title="token 银行兑换" style={{ marginTop: 16 }}>
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

          <Card className="token-card token-glass-card" title="兑换记录" style={{ marginTop: 16 }}>
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
          <Card className="token-card token-glass-card" title="余额与占比">
            <div className="token-metric">
              <Text>当前钱包总余额（基准模型视角）</Text>
              <Title level={3} style={{ margin: 0 }}>
                {totalInBaseline} token
              </Title>
            </div>
            <div ref={pieRef} className="token-chart" />
          </Card>
          <Card className="token-card token-glass-card" title="模型余额明细" style={{ marginTop: 16 }}>
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
    </>
  );

  const renderGiftPanel = () => (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={16}>
        <Card className="token-card token-glass-card" title="发起邀请" extra={<GiftOutlined />}>
          <Steps
            current={2}
            items={[
              {
                title: '1. 输入公钥',
                description: '粘贴对方 RSA 公钥（PEM 或单行 Base64）'
              },
              {
                title: '2. 选择配置',
                description: '默认使用当前钱包配置，也可手动编辑'
              },
              {
                title: '3. 一键生成',
                description: '生成可分享链接/密文'
              }
            ]}
            className="tokengift-steps"
          />
          <Divider />
          <Paragraph>
            <Text strong>接收方公钥</Text>
          </Paragraph>
          <Input.TextArea
            rows={4}
            value={recipientPublicKey}
            placeholder="-----BEGIN PUBLIC KEY-----\n..."
            onChange={(event) => setRecipientPublicKey(event.target.value)}
          />

          <Paragraph style={{ marginTop: 12 }}>
            <Text strong>待加密配置（默认派生当前配置）</Text>
          </Paragraph>
          <Input.TextArea
            rows={4}
            value={sendConfigText}
            onChange={(event) => setSendConfigText(event.target.value)}
          />

          <Space wrap style={{ marginTop: 12 }}>
            <Button type="primary" loading={isEncrypting} onClick={onCreateGift}>
              生成邀请密文/链接
            </Button>
            <Button icon={<ReloadOutlined />} onClick={onResetGiftDraft}>
              重置为当前配置
            </Button>
            <Button type="dashed" onClick={() => setSendConfigText(buildConfigShareCode(config, 'compact'))}>
              重新编码
            </Button>
          </Space>
        </Card>

        <Card className="token-card token-glass-card" title="发起结果" style={{ marginTop: 16 }}>
          <Paragraph>
            <Text strong>分享密文</Text>
          </Paragraph>
          <pre className="mono-block">{giftCipherText || '点击上方按钮后显示邀请密文'}</pre>
          <Space wrap style={{ marginTop: 12 }}>
            <Button
              icon={<CopyOutlined />}
              disabled={!giftCipherText}
              onClick={() => copyText(giftCipherText, '密文已复制')}
            >
              复制密文
            </Button>
          </Space>
          <Divider />
          <Paragraph>
            <Text strong>邀请链接</Text>
          </Paragraph>
          <Paragraph className="mono-block">{giftShareLink || '生成后自动拼接可分享链接'}</Paragraph>
          <Button
            icon={<CopyOutlined />}
            disabled={!giftShareLink}
            onClick={() => copyText(giftShareLink, '分享链接已复制')}
          >
            复制邀请链接
          </Button>
        </Card>
      </Col>

      <Col xs={24} lg={8}>
        <Card className="token-card token-glass-card" title="邀请须知">
          <Alert
            message="提示"
            description="加密结果使用 RSA-OAEP + SHA-256，并按 RSA 限制进行分块，用 `.` 连接。可直接把“邀请链接”或“密文”发给对方。"
            type="info"
            showIcon
          />
          <Divider />
          <Paragraph>
            <Text>支持输入公钥格式：标准 PEM、单行 Base64（自动识别）。建议使用 2048 或 3072 位以上密钥。 </Text>
          </Paragraph>
        </Card>
      </Col>
    </Row>
  );

  const renderClaimPanel = () => (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={16}>
        <Card className="token-card token-glass-card" title="领取配置" extra={<LockOutlined />}>
          <Steps
            current={1}
            items={[
              {
                title: '1. 粘贴私钥',
                description: '粘贴你的 RSA 私钥（PKCS#8 PEM）'
              },
              {
                title: '2. 粘贴密文',
                description: '支持直接粘贴链接或密文文本'
              },
              {
                title: '3. 一键解密加载',
                description: '成功后自动返回兑换中心并应用配置'
              }
            ]}
            className="tokengift-steps"
          />
          <Divider />
          <Paragraph>
            <Text strong>你的私钥</Text>
          </Paragraph>
          <Input.TextArea
            rows={4}
            value={recipientPrivateKey}
            placeholder="-----BEGIN PRIVATE KEY-----\n..."
            onChange={(event) => setRecipientPrivateKey(event.target.value)}
          />
          <Paragraph style={{ marginTop: 12 }}>
            <Text strong>邀请密文 / 邀请链接</Text>
          </Paragraph>
          <Input.TextArea
            rows={4}
            value={claimPayloadText}
            onChange={(event) => setClaimPayloadText(event.target.value)}
            placeholder="支持输入 gift=xxx 或完整链接"
          />

          <Space wrap style={{ marginTop: 12 }}>
            <Button
              type="primary"
              loading={isDecrypting}
              onClick={() =>
                void openGiftWithPayload(extractPayloadFromInput(claimPayloadText) || claimPayloadText)
              }
            >
              一键加载
            </Button>
            <Button icon={<ReloadOutlined />} onClick={onQuickOpen}>
              自动提取后再加载
            </Button>
            <Button type="dashed" onClick={() => setClaimPayloadText('')}>
              清空重试
            </Button>
          </Space>
        </Card>
      </Col>

      <Col xs={24} lg={8}>
        <Card className="token-card token-glass-card" title="载入后可直接兑换">
          <Alert
            message="隐私说明"
            description="配置仅在本地解密并留在当前浏览器。对方的私钥解密后才可读取明文。"
            type="warning"
            showIcon
          />
          <Divider />
          <Paragraph>
            <Text strong>当前可复制的数据快照</Text>
          </Paragraph>
          <pre className="mono-block">{shareableConfigCode}</pre>
          <Button icon={<CopyOutlined />} onClick={() => copyText(shareableConfigCode, '已复制当前配置摘要')}>
            一键复制当前配置
          </Button>
        </Card>
      </Col>
    </Row>
  );

  return (
    <Layout className="token-app">
      {contextHolder}
      <Header className="token-header">
        <div className="token-header-inner">
          <Title level={3}>tokengift · 交换与结算中心</Title>
          <Text>充值、兑换与配置赠与一体化</Text>
        </div>
      </Header>
      <Content className="token-content">
        <Card className="token-card token-glass-card token-summary-card">
          <Tabs
            activeKey={activeMode}
            onChange={(value) => setActiveMode(value as WorkMode)}
            items={[
              { key: 'swap', label: '兑换中心', children: renderSwapPanel() },
              { key: 'gift', label: '发起邀请', children: renderGiftPanel() },
              { key: 'claim', label: '领取礼物', children: renderClaimPanel() }
            ]}
            className="tokengift-tabs"
          />
        </Card>
      </Content>
    </Layout>
  );
};

export default App;
