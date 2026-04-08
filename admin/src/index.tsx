/* eslint-disable @typescript-eslint/no-explicit-any */
import { useIntl } from 'react-intl';
import { useNotification } from '@strapi/strapi/admin';

import { PLUGIN_ID } from './pluginId';
import { Initializer } from './components/Initializer';
import { PluginIcon } from './components/PluginIcon';
import { getTranslation } from './utils/getTranslation';
import { purgeEntry, purgeBulk } from './api';

// --- Document Action: Purge cache for a single entry ---
const PurgeCacheDocumentAction = (props: any) => {
  const { formatMessage } = useIntl();
  const { toggleNotification } = useNotification();

  const { model, document, documentId } = props;

  if (!documentId || !document) {
    return null;
  }

  return {
    label: formatMessage({
      id: getTranslation('action.purge'),
      defaultMessage: 'Purge Cache',
    }),
    icon: <PluginIcon />,
    variant: 'secondary' as const,
    position: ['panel', 'table-row'] as const,
    dialog: {
      type: 'dialog' as const,
      title: formatMessage({
        id: getTranslation('action.purge.confirm-title'),
        defaultMessage: 'Purge Cache',
      }),
      content: formatMessage({
        id: getTranslation('action.purge.confirm-body'),
        defaultMessage: 'Are you sure you want to purge the cache for this entry?',
      }),
      onConfirm: async () => {
        try {
          const result = await purgeEntry(model, documentId);
          if (result?.success === false) {
            toggleNotification({
              type: 'danger',
              message: formatMessage({
                id: getTranslation('action.purge.error'),
                defaultMessage: 'Failed to purge cache',
              }),
            });
          } else {
            toggleNotification({
              type: 'success',
              message: formatMessage({
                id: getTranslation('action.purge.success'),
                defaultMessage: 'Cache purged successfully',
              }),
            });
          }
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
          toggleNotification({
            type: 'danger',
            message: formatMessage({
              id: getTranslation('action.purge.error'),
              defaultMessage: 'Failed to purge cache',
            }),
          });
        }
      },
    },
  };
};

// --- Bulk Action: Purge cache for multiple entries ---
const PurgeCacheBulkAction = (props: any) => {
  const { formatMessage } = useIntl();
  const { toggleNotification } = useNotification();

  const { model, documents } = props;
  const documentIds = (documents || []).map((d: any) => d.documentId).filter(Boolean);

  if (documentIds.length === 0) {
    return null;
  }

  return {
    label: formatMessage(
      {
        id: getTranslation('action.purge-bulk'),
        defaultMessage: 'Purge Cache ({count})',
      },
      { count: documentIds.length }
    ),
    icon: <PluginIcon />,
    variant: 'secondary' as const,
    dialog: {
      type: 'dialog' as const,
      title: formatMessage({
        id: getTranslation('action.purge-bulk.confirm-title'),
        defaultMessage: 'Purge Cache',
      }),
      content: formatMessage(
        {
          id: getTranslation('action.purge-bulk.confirm-body'),
          defaultMessage: 'Are you sure you want to purge the cache for {count} entries?',
        },
        { count: documentIds.length }
      ),
      onConfirm: async () => {
        try {
          const result = await purgeBulk(model, documentIds);
          if (result?.success === false) {
            toggleNotification({
              type: 'danger',
              message: formatMessage({
                id: getTranslation('action.purge-bulk.error'),
                defaultMessage: 'Failed to purge cache',
              }),
            });
          } else {
            toggleNotification({
              type: 'success',
              message: formatMessage(
                {
                  id: getTranslation('action.purge-bulk.success'),
                  defaultMessage: 'Cache purged for {count} entries',
                },
                { count: documentIds.length }
              ),
            });
          }
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
          toggleNotification({
            type: 'danger',
            message: formatMessage({
              id: getTranslation('action.purge-bulk.error'),
              defaultMessage: 'Failed to purge cache',
            }),
          });
        }
      },
    },
  };
};

export default {
  register(app: any) {
    // Register plugin
    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: PLUGIN_ID,
    });

    // Settings page in sidebar
    app.addSettingsLink(
      {
        id: PLUGIN_ID,
        intlLabel: {
          id: getTranslation('settings.section'),
          defaultMessage: 'Cache Manager',
        },
      },
      [
        {
          id: `${PLUGIN_ID}-dashboard`,
          intlLabel: {
            id: getTranslation('settings.link'),
            defaultMessage: 'Dashboard',
          },
          to: PLUGIN_ID,
          Component: () => import('./pages/Settings'),
          permissions: [],
        },
      ]
    );

    // Document Action (single entry purge)
    const cmPlugin = app.getPlugin('content-manager');
    if (cmPlugin?.apis?.addDocumentAction) {
      cmPlugin.apis.addDocumentAction((prev: any[]) => [...prev, PurgeCacheDocumentAction]);
    }

    // Bulk Action (multi-entry purge)
    if (cmPlugin?.apis?.addBulkAction) {
      cmPlugin.apis.addBulkAction((prev: any[]) => [...prev, PurgeCacheBulkAction]);
    }
  },

  async registerTrads({ locales }: { locales: string[] }) {
    return Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = await import(`./translations/${locale}.json`);
          return { data, locale };
        } catch {
          return { data: {}, locale };
        }
      })
    );
  },
};
