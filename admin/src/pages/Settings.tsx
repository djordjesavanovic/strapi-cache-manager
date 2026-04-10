/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { useIntl } from 'react-intl';
import {
  Box,
  Flex,
  Typography,
  Button,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Badge,
  Alert,
  Loader,
  Dialog,
} from '@strapi/design-system';
import { Layouts, useNotification } from '@strapi/strapi/admin';
import { Trash, ArrowClockwise } from '@strapi/icons';

import { getTranslation } from '../utils/getTranslation';
import { fetchProviders, fetchStats, fetchContentTypeMapping, purgeAll } from '../api';

interface ProviderSummary {
  name: string;
  type: string;
  endpoints: string[];
}

interface ContentTypeMappingEntry {
  pathPattern?: string;
  relatedPaths?: string[];
  purgeAllOnChange?: boolean;
  tags?: string[];
}

interface StatsResult {
  provider: string;
  success: boolean;
  data?: any;
  error?: string;
}

const Settings = () => {
  const { formatMessage } = useIntl();
  const { toggleNotification } = useNotification();

  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [stats, setStats] = useState<StatsResult[]>([]);
  const [mapping, setMapping] = useState<Record<string, ContentTypeMappingEntry>>({});
  const [loading, setLoading] = useState(true);
  const [purging, setPurging] = useState<string | null>(null);
  const [showPurgeAllDialog, setShowPurgeAllDialog] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [providersData, statsData, mappingData] = await Promise.all([
        fetchProviders(),
        fetchStats(),
        fetchContentTypeMapping(),
      ]);
      setProviders(providersData);
      setStats(statsData);
      setMapping(mappingData || {});
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('settings.load-error'),
          defaultMessage: 'Failed to load cache data',
        }),
      });
    } finally {
      setLoading(false);
    }
  }, [formatMessage, toggleNotification]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handlePurgeAll = async () => {
    setPurging('all');
    setShowPurgeAllDialog(false);
    try {
      const result = await purgeAll();
      toggleNotification({
        type: 'success',
        message: formatMessage(
          {
            id: getTranslation('settings.purge-all-success'),
            defaultMessage: 'All caches purged ({count} operations)',
          },
          { count: result.results?.length || 0 }
        ),
      });
      await loadData();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('settings.purge-all-error'),
          defaultMessage: 'Failed to purge all caches',
        }),
      });
    } finally {
      setPurging(null);
    }
  };

  const handlePurgeProvider = async (providerName: string) => {
    setPurging(providerName);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const result = await purgeAll(providerName);
      toggleNotification({
        type: 'success',
        message: formatMessage(
          {
            id: getTranslation('settings.purge-provider-success'),
            defaultMessage: '{provider} cache purged',
          },
          { provider: providerName }
        ),
      });
      await loadData();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      toggleNotification({
        type: 'danger',
        message: formatMessage(
          {
            id: getTranslation('settings.purge-provider-error'),
            defaultMessage: 'Failed to purge {provider} cache',
          },
          { provider: providerName }
        ),
      });
    } finally {
      setPurging(null);
    }
  };

  if (loading) {
    return (
      <Layouts.Root>
        <Layouts.Header
          title={formatMessage({
            id: getTranslation('settings.title'),
            defaultMessage: 'Cache Manager',
          })}
          subtitle={formatMessage({
            id: getTranslation('settings.subtitle'),
            defaultMessage: 'Manage and invalidate caches',
          })}
        />
        <Layouts.Content>
          <Flex justifyContent="center" padding={8}>
            <Loader>
              {formatMessage({
                id: getTranslation('settings.loading'),
                defaultMessage: 'Loading cache data...',
              })}
            </Loader>
          </Flex>
        </Layouts.Content>
      </Layouts.Root>
    );
  }

  return (
    <Layouts.Root>
      <Layouts.Header
        title={formatMessage({
          id: getTranslation('settings.title'),
          defaultMessage: 'Cache Manager',
        })}
        subtitle={formatMessage({
          id: getTranslation('settings.subtitle'),
          defaultMessage: 'Manage and invalidate caches',
        })}
        primaryAction={
          <Flex gap={2}>
            <Button startIcon={<ArrowClockwise />} variant="secondary" onClick={loadData}>
              {formatMessage({
                id: getTranslation('settings.refresh'),
                defaultMessage: 'Refresh',
              })}
            </Button>
            <Dialog.Root open={showPurgeAllDialog} onOpenChange={setShowPurgeAllDialog}>
              <Dialog.Trigger>
                <Button startIcon={<Trash />} variant="danger" loading={purging === 'all'}>
                  {formatMessage({
                    id: getTranslation('settings.purge-all'),
                    defaultMessage: 'Purge All Caches',
                  })}
                </Button>
              </Dialog.Trigger>
              <Dialog.Content>
                <Dialog.Header>
                  {formatMessage({
                    id: getTranslation('settings.purge-all-confirm-title'),
                    defaultMessage: 'Purge All Caches',
                  })}
                </Dialog.Header>
                <Dialog.Body>
                  {formatMessage({
                    id: getTranslation('settings.purge-all-confirm-body'),
                    defaultMessage:
                      'Are you sure you want to purge all caches? This will clear all cached data across all providers.',
                  })}
                </Dialog.Body>
                <Dialog.Footer>
                  <Dialog.Cancel>
                    <Button variant="tertiary">
                      {formatMessage({
                        id: getTranslation('settings.cancel'),
                        defaultMessage: 'Cancel',
                      })}
                    </Button>
                  </Dialog.Cancel>
                  <Dialog.Action>
                    <Button variant="danger" onClick={handlePurgeAll}>
                      {formatMessage({
                        id: getTranslation('settings.confirm'),
                        defaultMessage: 'Confirm',
                      })}
                    </Button>
                  </Dialog.Action>
                </Dialog.Footer>
              </Dialog.Content>
            </Dialog.Root>
          </Flex>
        }
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={8}>
          {/* Providers */}
          <Box>
            <Box paddingBottom={4}>
              <Typography variant="beta" tag="h2">
                {formatMessage({
                  id: getTranslation('settings.providers-title'),
                  defaultMessage: 'Cache Providers',
                })}
              </Typography>
            </Box>
            {providers.length === 0 ? (
              <Alert closeLabel="Close" variant="default">
                {formatMessage({
                  id: getTranslation('settings.no-providers'),
                  defaultMessage:
                    'No cache providers configured. Add providers in your plugin configuration.',
                })}
              </Alert>
            ) : (
              <Table colCount={4} rowCount={providers.length + 1}>
                <Thead>
                  <Tr>
                    <Th>
                      <Typography variant="sigma">
                        {formatMessage({
                          id: getTranslation('settings.provider-name'),
                          defaultMessage: 'Name',
                        })}
                      </Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">
                        {formatMessage({
                          id: getTranslation('settings.provider-type'),
                          defaultMessage: 'Type',
                        })}
                      </Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">
                        {formatMessage({
                          id: getTranslation('settings.provider-endpoints'),
                          defaultMessage: 'Endpoints',
                        })}
                      </Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">
                        {formatMessage({
                          id: getTranslation('settings.provider-actions'),
                          defaultMessage: 'Actions',
                        })}
                      </Typography>
                    </Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {providers.map((provider) => (
                    <Tr key={provider.name}>
                      <Td>
                        <Typography textColor="neutral800">{provider.name}</Typography>
                      </Td>
                      <Td>
                        <Badge>{provider.type}</Badge>
                      </Td>
                      <Td>
                        <Flex gap={1} wrap="wrap">
                          {provider.endpoints.map((ep) => (
                            <Badge key={ep} active={true}>
                              {ep}
                            </Badge>
                          ))}
                        </Flex>
                      </Td>
                      <Td>
                        {provider.endpoints.includes('purgeAll') && (
                          <Button
                            variant="danger-light"
                            size="S"
                            startIcon={<Trash />}
                            loading={purging === provider.name}
                            onClick={() => handlePurgeProvider(provider.name)}
                          >
                            {formatMessage({
                              id: getTranslation('settings.purge'),
                              defaultMessage: 'Purge',
                            })}
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </Box>

          {/* Content Type Mapping */}
          <Box>
            <Box paddingBottom={4}>
              <Typography variant="beta" tag="h2">
                {formatMessage({
                  id: getTranslation('settings.mapping-title'),
                  defaultMessage: 'Content Type Mapping',
                })}
              </Typography>
            </Box>
            {Object.keys(mapping).length === 0 ? (
              <Alert closeLabel="Close" variant="default">
                {formatMessage({
                  id: getTranslation('settings.no-mapping'),
                  defaultMessage:
                    'No content type mapping configured. Add mappings in your plugin configuration.',
                })}
              </Alert>
            ) : (
              <Table colCount={5} rowCount={Object.keys(mapping).length + 1}>
                <Thead>
                  <Tr>
                    <Th>
                      <Typography variant="sigma">
                        {formatMessage({
                          id: getTranslation('settings.mapping-content-type'),
                          defaultMessage: 'Content Type',
                        })}
                      </Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">
                        {formatMessage({
                          id: getTranslation('settings.mapping-path-pattern'),
                          defaultMessage: 'Path Pattern',
                        })}
                      </Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">
                        {formatMessage({
                          id: getTranslation('settings.mapping-related-paths'),
                          defaultMessage: 'Also Purges',
                        })}
                      </Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">
                        {formatMessage({
                          id: getTranslation('settings.mapping-tags'),
                          defaultMessage: 'Invalidation Tags',
                        })}
                      </Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">
                        {formatMessage({
                          id: getTranslation('settings.mapping-behavior'),
                          defaultMessage: 'Behavior',
                        })}
                      </Typography>
                    </Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {Object.entries(mapping).map(([uid, config]) => {
                    const friendlyName = uid.split('.').pop() || uid;
                    const displayName =
                      friendlyName.charAt(0).toUpperCase() + friendlyName.slice(1);

                    return (
                      <Tr key={uid}>
                        <Td>
                          <Flex direction="column" alignItems="flex-start" gap={1}>
                            <Typography textColor="neutral800" fontWeight="bold">
                              {displayName}
                            </Typography>
                            <Typography variant="pi" textColor="neutral500">
                              {uid}
                            </Typography>
                          </Flex>
                        </Td>
                        <Td>
                          {config.pathPattern ? (
                            <Badge>{config.pathPattern}</Badge>
                          ) : (
                            <Typography textColor="neutral400">—</Typography>
                          )}
                        </Td>
                        <Td>
                          {config.relatedPaths && config.relatedPaths.length > 0 ? (
                            <Flex gap={1} wrap="wrap">
                              {config.relatedPaths.map((p) => (
                                <Badge key={p}>{p}</Badge>
                              ))}
                            </Flex>
                          ) : (
                            <Typography textColor="neutral400">—</Typography>
                          )}
                        </Td>
                        <Td>
                          {config.tags && config.tags.length > 0 ? (
                            <Flex gap={1} wrap="wrap">
                              {config.tags.map((t) => (
                                <Badge key={t} active={true}>
                                  {t}
                                </Badge>
                              ))}
                            </Flex>
                          ) : (
                            <Typography textColor="neutral400">—</Typography>
                          )}
                        </Td>
                        <Td>
                          {config.purgeAllOnChange ? (
                            <Badge active={true}>
                              {formatMessage({
                                id: getTranslation('settings.mapping-purge-all'),
                                defaultMessage: 'Purge All',
                              })}
                            </Badge>
                          ) : (
                            <Typography textColor="neutral400">—</Typography>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
            )}
          </Box>

          {/* Statistics */}
          {stats.length > 0 && (
            <Box>
              <Box paddingBottom={4}>
                <Typography variant="beta" tag="h2">
                  {formatMessage({
                    id: getTranslation('settings.stats-title'),
                    defaultMessage: 'Cache Statistics',
                  })}
                </Typography>
              </Box>
              <Flex direction="column" alignItems="stretch" gap={4}>
                {stats.map((stat) => (
                  <Box
                    key={stat.provider}
                    background="neutral0"
                    shadow="filterShadow"
                    padding={4}
                    hasRadius
                  >
                    <Flex justifyContent="space-between" alignItems="center">
                      <Typography variant="omega" fontWeight="bold">
                        {stat.provider}
                      </Typography>
                      <Badge active={stat.success}>{stat.success ? 'Connected' : 'Error'}</Badge>
                    </Flex>
                    {stat.success && stat.data && (
                      <Box paddingTop={2}>
                        <Typography variant="pi" textColor="neutral600">
                          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.85em' }}>
                            {JSON.stringify(stat.data, null, 2)}
                          </pre>
                        </Typography>
                      </Box>
                    )}
                    {!stat.success && stat.error && (
                      <Box paddingTop={2}>
                        <Typography variant="pi" textColor="danger600">
                          {stat.error}
                        </Typography>
                      </Box>
                    )}
                  </Box>
                ))}
              </Flex>
            </Box>
          )}
        </Flex>
      </Layouts.Content>
    </Layouts.Root>
  );
};

export default Settings;
