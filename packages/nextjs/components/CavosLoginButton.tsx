'use client';

import { useCavos } from '@cavos/react';
import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import deployedContracts from "~~/contracts/deployedContracts";

interface CavosLoginButtonProps {
  disabled?: boolean; // Ahora lo usaremos para deshabilitar cuando wallet esté conectada
}

export const CavosLoginButton = ({ disabled }: CavosLoginButtonProps) => {
  const cavosContext = useCavos();
  const { 
    login, 
    address, 
    isAuthenticated, 
    walletStatus, 
    registerCurrentSession,
    logout 
  } = cavosContext;
  const [isLoading, setIsLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Log del estado para depuración
  useEffect(() => {
    if (isAuthenticated && address) {
      console.log('Cavos status:', { 
        isAuthenticated, 
        address, 
        walletStatus,
        hasRegisterMethod: !!registerCurrentSession 
      });
    }
  }, [isAuthenticated, address, walletStatus, registerCurrentSession]);

  const handleGoogleLogin = async () => {
    setIsLoading(true);
    setSessionError(null);
    try {
      // 1. Autenticar con Google
      await login('google');

      // 2. Obtener dirección del contrato
      const contractAddress = deployedContracts.sepolia?.SealedBidFeedlot?.address;
      if (!contractAddress) {
        throw new Error("Contract address not found");
      }

      // 3. Obtener el objeto cavos (si existe)
      const cavos = (cavosContext as any).cavos;

      // 4. Crear sesión con política (si existe el método)
      if (cavos?.createSession) {
        const policy = {
          allowedMethods: [
            { contractAddress, selector: 'commit_bid' },
            { contractAddress, selector: 'reveal_bid' },
            { contractAddress, selector: 'finalize_lot' },
            { contractAddress, selector: 'create_lot' },
          ],
          expiresAt: Date.now() + 60 * 60 * 1000, // 1 hora
        };
        await cavos.createSession(policy);
        console.log('✅ Sesión creada');
      } else {
        console.warn('createSession no disponible');
      }

      // 5. Registrar sesión on‑chain (priorizar registerCurrentSession del hook)
      if (registerCurrentSession) {
        await registerCurrentSession();
        console.log('✅ Sesión registrada con registerCurrentSession');
      } else if (cavos?.registerSession) {
        await cavos.registerSession();
        console.log('✅ Sesión registrada con cavos.registerSession');
      } else {
        console.warn('No se encontró método para registrar sesión');
      }

      // 6. Verificar estado final
      if (walletStatus?.isSessionActive) {
        toast.success('✅ Wallet lista y sesión activa');
      } else {
        setSessionError('Sesión no activa después del registro');
        toast.error('Sesión no activa. Puede necesitar un reintento.');
      }

      // 7. Recargar para reiniciar hooks
      window.location.reload();
    } catch (err) {
      console.error('Login error:', err);
      toast.error('Login failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRetrySession = async () => {
    setIsLoading(true);
    try {
      const cavos = (cavosContext as any).cavos;
      if (cavos?.registerSession) {
        await cavos.registerSession();
        toast.success('Sesión registrada manualmente');
        window.location.reload();
      } else if (registerCurrentSession) {
        await registerCurrentSession();
        toast.success('Sesión registrada manualmente');
        window.location.reload();
      } else {
        toast.error('No hay método para registrar sesión');
      }
    } catch (err) {
      toast.error('Error al registrar sesión: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsLoading(false);
    }
  };

  // Si está autenticado, mostramos la dirección y opciones
  if (isAuthenticated && address) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm bg-green-100 dark:bg-green-900 text-gray-800 dark:text-gray-200 px-2 py-1 rounded">
          🔐 {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        {!walletStatus?.isSessionActive && (
          <button
            onClick={handleRetrySession}
            className="btn btn-xs btn-warning dark:bg-yellow-600 dark:hover:bg-yellow-700 dark:text-white"
            disabled={isLoading}
          >
            Activar sesión
          </button>
        )}
        <button 
          onClick={() => logout?.() || window.location.reload()} 
          className="btn btn-ghost btn-xs dark:text-gray-300 dark:hover:text-white"
          disabled={isLoading}
        >
          ✕
        </button>
      </div>
    );
  }

  // No autenticado: mostramos el botón de login, pero lo envolvemos en un div que lo deshabilita si `disabled` es true
  return (
    <div className={disabled ? "opacity-50 pointer-events-none" : ""}>
      <button
        onClick={handleGoogleLogin}
        className="btn btn-primary btn-sm"
        disabled={isLoading}
      >
        {isLoading ? (
          <span className="loading loading-spinner loading-xs mr-2"></span>
        ) : (
          <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24">
            <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
        )}
        Login with Google
      </button>
    </div>
  );
};